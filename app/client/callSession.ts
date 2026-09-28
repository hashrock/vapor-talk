import {
  CloseCode,
  TERMINAL_CLOSE_CODES,
  type ClientMessage,
  type Participant,
  type PublishedTrack,
  type ServerMessage,
  type TrackKind,
} from "../domain/protocol";
import { bandwidth, sampleStats, type BandwidthStats, type StatsSample } from "./stats";
import { desiredRemoteTracks, focusedShare, planTrackSync, type RemoteTrackRef } from "./trackPlan";

/**
 * 1回の通話。ルームの WebSocket（在室・公開トラックの共有）と、
 * SFU への RTCPeerConnection（音声・画面の送受信）を1本ずつ持つ。
 * マイクを取るのはスピーカーのときだけ。ロールは RoomDO が決め、変わったら（昇格・降格）追従する。
 *
 * SFU とのネゴシエーションは直列でしか正しく動かないので、すべて `serial` に積む。
 * React からは subscribe / getSnapshot（useSyncExternalStore）で状態を読む。
 */

export type CallStatus = "joining" | "connected" | "reconnecting" | "ended";

export type EndReason = "left" | "room-full" | "room-deleted" | "room-expired" | "replaced" | "error";

export type ParticipantMedia = Partial<Record<TrackKind, MediaStream>>;

/** 発話中の participantId。音量メーターは頻繁に変わるので CallState とは別に購読する。 */
export type Speaking = ReadonlySet<string>;

export interface CallState {
  status: CallStatus;
  endReason: EndReason | null;
  error: string | null;
  selfId: string | null;
  participants: Participant[];
  /** participantId → 受信中のメディア。自分の画面共有もここに入る（自分の mic は入れない）。 */
  media: Record<string, ParticipantMedia>;
  /** participantId → 0..1 */
  volumes: Record<string, number>;
  micAvailable: boolean;
  muted: boolean;
  sharing: boolean;
  /** ステージで見たい共有者（null なら最初の共有者）。実際に出す人は focusedShare() で決める */
  selectedShare: string | null;
  expiresAt: string | null;
}

interface JoinResponse {
  participantId: string;
  ticket: string;
}

interface SfuTrackResult {
  mid?: string;
  trackName?: string;
  sessionId?: string;
  errorCode?: string;
  errorDescription?: string;
}

interface SfuTracksResponse {
  sessionDescription?: RTCSessionDescriptionInit;
  requiresImmediateRenegotiation?: boolean;
  tracks?: SfuTrackResult[];
  errorCode?: string;
  errorDescription?: string;
}

interface PulledTrack extends RemoteTrackRef {
  mid: string;
}

interface PushTrack {
  track: MediaStreamTrack;
  trackName: string;
  kind: TrackKind;
  encodings?: RTCRtpEncodingParameters[];
}

interface LocalTrack {
  trackName: string;
  kind: TrackKind;
  track: MediaStreamTrack;
  transceiver: RTCRtpTransceiver;
}

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];
const SPEAKING_THRESHOLD = 0.03;
const MAX_RECONNECTS = 6;
/** 相手の push 直後などで pull に失敗したときに取り直す回数（成功したら戻す） */
const PULL_RETRIES = 5;
/**
 * 画面共有の送信ビットレート上限。既定（720p 以上で約 2.5 Mbps）のままだと、
 * スクロールや動画で全員分の帯域が跳ね上がる。contentHint="detail" なので、
 * 足りないときは解像度ではなくフレームレートが落ちる（文字は読めるまま）。
 */
const SCREEN_MAX_BITRATE = 1_000_000;
const STATS_INTERVAL_MS = 2000;

/** 値 1 つを購読できる小さなストア。購読者がいる間だけ動かしたいもの（統計）は onActive で開始・停止する。 */
class Channel<T> {
  private listeners = new Set<() => void>();
  constructor(
    private value: T,
    private readonly onActive?: (active: boolean) => void,
  ) {}
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    if (this.listeners.size === 1) this.onActive?.(true);
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0) this.onActive?.(false);
    };
  };
  get = () => this.value;
  set(value: T) {
    this.value = value;
    for (const fn of this.listeners) fn();
  }
}

export class CallSession {
  private state: CallState = {
    status: "joining",
    endReason: null,
    error: null,
    selfId: null,
    participants: [],
    media: {},
    volumes: {},
    micAvailable: false,
    muted: true,
    sharing: false,
    selectedShare: null,
    expiresAt: null,
  };
  private listeners = new Set<() => void>();

  private join: JoinResponse | null = null;
  private pc: RTCPeerConnection | null = null;
  private ws: WebSocket | null = null;
  private serial: Promise<unknown> = Promise.resolve();
  private syncQueued = false;
  private reconnects = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  private local: LocalTrack[] = [];
  /** スピーカーとしてマイクを使う（取得中を含む）。降格で false */
  private micWanted = false;
  private micStream: MediaStream | null = null;
  private micSeq = 0;
  private screenStream: MediaStream | null = null;
  private screenSeq = 0;

  private pulled = new Map<string, PulledTrack>();
  private pullRetries = PULL_RETRIES;

  private audioCtx: AudioContext | null = null;
  private analysers = new Map<string, { analyser: AnalyserNode; source: MediaStreamAudioSourceNode }>();
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private levelBuf = new Float32Array(512);
  /** 発話中の participantId。頻繁に変わるので CallState とは別に購読する */
  readonly speaking = new Channel<Speaking>(new Set());
  /** 帯域の統計。購読されている間（統計パネルを開いている間）だけ getStats() する */
  readonly stats = new Channel<BandwidthStats | null>(null, (active) => this.pollStats(active));
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private lastSample: StatsSample | null = null;

  constructor(
    private readonly roomId: string,
    private readonly name: string,
    private readonly inviteToken: string | null,
  ) {}

  // --- external store ---

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.state;

  private set(patch: Partial<CallState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  // --- lifecycle ---

  /** 入室。ボタン押下から呼ぶこと（音声の自動再生のため）。マイクはスピーカーになってから取る。 */
  async start(): Promise<void> {
    try {
      this.audioCtx = new AudioContext();
      const res = await fetch(`/api/rooms/${this.roomId}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: this.name, token: this.inviteToken }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<JoinResponse> & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `入室に失敗しました (${res.status})`);
      this.join = body as JoinResponse;
      this.set({ selfId: this.join.participantId });

      this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, bundlePolicy: "max-bundle" });
      this.pc.ontrack = (e) => this.onTrack(e);
      this.pc.onconnectionstatechange = () => {
        if (this.pc?.connectionState === "failed") this.fail("通話サーバーとの接続が切れました");
      };
      this.levelTimer = setInterval(() => this.updateSpeaking(), 120);

      // 自分のロールは welcome で分かる。スピーカーならそこでマイクを取る（followRole）
      this.openSocket();
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
    }
  }

  leave() {
    this.end("left");
  }

  private fail(message: string) {
    console.error("[vapor-talk]", message);
    this.end("error", message);
  }

  private end(reason: EndReason, error: string | null = null) {
    if (this.state.status === "ended") return;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.pollStats(false);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close(1000, "leave");
    }
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.screenStream?.getTracks().forEach((t) => t.stop());
    this.pc?.close();
    void this.audioCtx?.close();
    this.set({ status: "ended", endReason: reason, error, media: {}, sharing: false });
  }

  // --- controls ---

  setMuted(muted: boolean) {
    const mic = this.micStream?.getAudioTracks()[0];
    if (!mic) return;
    mic.enabled = !muted;
    this.set({ muted });
    this.send({ type: "update", muted });
  }

  setVolume(participantId: string, volume: number) {
    this.set({ volumes: { ...this.state.volumes, [participantId]: Math.min(1, Math.max(0, volume)) } });
  }

  /** ステージに出す画面を選ぶ。見ていない画面は pull しないので、切り替えると取り直す */
  selectShare(participantId: string) {
    this.set({ selectedShare: participantId });
    this.scheduleSync();
  }

  /** 挙手 / 取り下げ（ログイン済みのリスナー） */
  raiseHand(raised: boolean) {
    this.send({ type: "hand", raised });
  }

  /** ホスト: リスナーをスピーカーにする（挙手の許可・指名） */
  promote(participantId: string) {
    this.send({ type: "promote", id: participantId });
  }

  /** ホスト: スピーカーをリスナーに戻す */
  demote(participantId: string) {
    this.send({ type: "demote", id: participantId });
  }

  /** ホスト: 挙手を却下する */
  rejectHand(participantId: string) {
    this.send({ type: "reject", id: participantId });
  }

  async startScreenShare(): Promise<void> {
    if (this.state.sharing || !this.join || this.self()?.role !== "speaker") return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: true });
    } catch {
      return; // ユーザーがキャンセル
    }
    const seq = ++this.screenSeq;
    const video = stream.getVideoTracks()[0];
    if (!video) return;
    video.contentHint = "detail";
    video.addEventListener("ended", () => void this.stopScreenShare());
    const tracks: PushTrack[] = [
      { track: video, trackName: `screen-${seq}`, kind: "screen", encodings: [{ maxBitrate: SCREEN_MAX_BITRATE }] },
    ];
    const audio = stream.getAudioTracks()[0];
    if (audio) tracks.push({ track: audio, trackName: `screen-audio-${seq}`, kind: "screen-audio" });

    this.screenStream = stream;
    this.set({ sharing: true, media: { ...this.state.media, [this.join.participantId]: { screen: new MediaStream([video]) } } });
    try {
      await this.enqueue(() => this.pushTracks(tracks));
      this.publish();
    } catch (e) {
      console.error(e);
      await this.stopScreenShare();
    }
  }

  async stopScreenShare(): Promise<void> {
    if (!this.screenStream || !this.join) return;
    const stream = this.screenStream;
    this.screenStream = null;
    stream.getTracks().forEach((t) => t.stop());
    const closing = this.local.filter((l) => l.kind !== "mic");
    this.local = this.local.filter((l) => l.kind === "mic");
    const { [this.join.participantId]: _, ...media } = this.state.media;
    this.set({ sharing: false, media });
    this.publish();
    await this.enqueue(() => this.closeTransceivers(closing.map((l) => l.transceiver)));
  }

  // --- WebSocket ---

  private openSocket() {
    if (!this.join) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/api/rooms/${this.roomId}/ws?ticket=${encodeURIComponent(this.join.ticket)}`);
    this.ws = ws;
    ws.onmessage = (e) => this.onMessage(JSON.parse(e.data as string) as ServerMessage);
    ws.onclose = (e) => this.onSocketClose(e);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => this.send({ type: "ping" }), 25_000);
  }

  private onSocketClose(e: CloseEvent) {
    if (this.state.status === "ended") return;
    if (TERMINAL_CLOSE_CODES.has(e.code)) {
      this.dismissed(e.code);
      return;
    }
    if (this.reconnects >= MAX_RECONNECTS) {
      this.fail("ルームへの接続が切れました");
      return;
    }
    const delay = Math.min(1000 * 2 ** this.reconnects, 10_000);
    this.reconnects++;
    this.set({ status: "reconnecting" });
    setTimeout(() => {
      if (this.state.status !== "ended") this.openSocket();
    }, delay);
  }

  private dismissed(code: number) {
    const reason: Record<number, EndReason> = {
      [CloseCode.RoomFull]: "room-full",
      [CloseCode.RoomDeleted]: "room-deleted",
      [CloseCode.RoomExpired]: "room-expired",
      [CloseCode.Replaced]: "replaced",
    };
    this.end(reason[code] ?? "error");
  }

  private onMessage(msg: ServerMessage) {
    switch (msg.type) {
      case "bye":
        this.dismissed(msg.code);
        return;
      case "welcome":
        this.reconnects = 0;
        this.set({ status: "connected", participants: msg.participants, expiresAt: msg.expiresAt });
        // 再接続時も含め、自分の公開トラックとミュート状態を送り直す
        this.publish();
        this.followRole();
        break;
      case "joined":
      case "updated":
        this.set({ participants: upsert(this.state.participants, msg.participant) });
        if (msg.participant.id === this.state.selfId) this.followRole();
        break;
      case "left": {
        const { [msg.id]: _, ...media } = this.state.media;
        this.set({ participants: this.state.participants.filter((p) => p.id !== msg.id), media });
        break;
      }
      case "pong":
        return;
    }
    this.scheduleSync();
  }

  private send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private self(): Participant | undefined {
    return this.state.participants.find((p) => p.id === this.state.selfId);
  }

  /** 自分のロールに合わせてマイクを取る・手放す。 */
  private followRole() {
    const role = this.self()?.role;
    if (role === "speaker" && !this.micWanted) void this.startMic();
    else if (role === "listener" && this.micWanted) void this.stopMic();
  }

  private async startMic() {
    this.micWanted = true;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      // マイクが無い・拒否された場合は聞くだけのスピーカーになる
      return;
    }
    // 許可を待つ間に降格・退出していたら使わない
    if (!this.micWanted || this.state.status === "ended" || !this.join) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const mic = stream.getAudioTracks()[0];
    try {
      await this.enqueue(() => this.pushTracks([{ track: mic, trackName: `mic-${++this.micSeq}`, kind: "mic" }]));
    } catch (e) {
      console.error("[vapor-talk] mic push failed", e);
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.micStream = stream;
    this.watchLevel(this.join.participantId, stream);
    this.set({ micAvailable: true, muted: false });
    this.publish();
    // push の間に降格されていたら閉じる
    if (!this.micWanted) await this.stopMic();
  }

  private async stopMic() {
    this.micWanted = false;
    await this.stopScreenShare();
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    if (this.join) this.unwatchLevel(this.join.participantId);
    const closing = this.local.filter((l) => l.kind === "mic");
    this.local = this.local.filter((l) => l.kind !== "mic");
    this.set({ micAvailable: false, muted: true });
    this.publish();
    await this.enqueue(() => this.closeTransceivers(closing.map((l) => l.transceiver)));
  }

  private publish() {
    const tracks: PublishedTrack[] = this.local.map((l) => ({ trackName: l.trackName, kind: l.kind }));
    this.send({ type: "update", tracks, muted: this.state.muted });
  }

  // --- SFU negotiation（すべて serial 上で実行する） ---

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.serial.then(fn);
    this.serial = next.catch(() => undefined);
    return next;
  }

  private async sfu(method: "POST" | "PUT", action: string, body: unknown): Promise<SfuTracksResponse> {
    const res = await fetch(`/api/rooms/${this.roomId}/sfu/${action}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.join!.ticket}` },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as SfuTracksResponse;
    if (!res.ok || json.errorCode) {
      throw new Error(`SFU ${action} failed: ${json.errorCode ?? res.status} ${json.errorDescription ?? ""}`);
    }
    return json;
  }

  private async pushTracks(tracks: PushTrack[]) {
    const pc = this.pc!;
    const transceivers = tracks.map((t) => pc.addTransceiver(t.track, { direction: "sendonly", sendEncodings: t.encodings }));
    await pc.setLocalDescription(await pc.createOffer());
    const res = await this.sfu("POST", "tracks/new", {
      sessionDescription: { type: "offer", sdp: pc.localDescription!.sdp },
      tracks: transceivers.map((tr, i) => ({ location: "local", mid: tr.mid, trackName: tracks[i].trackName })),
    });
    await pc.setRemoteDescription(res.sessionDescription!);
    tracks.forEach((t, i) => this.local.push({ trackName: t.trackName, kind: t.kind, track: t.track, transceiver: transceivers[i] }));
  }

  private scheduleSync() {
    if (this.syncQueued || !this.pc) return;
    this.syncQueued = true;
    void this.enqueue(async () => {
      this.syncQueued = false;
      await this.syncRemote();
    }).catch((e) => console.error("[vapor-talk] sync failed", e));
  }

  /** 在室者の公開トラックと、自分が pull しているトラックを一致させる。 */
  private async syncRemote() {
    if (!this.pc || this.state.status === "ended" || !this.join) return;
    const { participants, selectedShare } = this.state;
    const plan = planTrackSync(
      this.pulled,
      desiredRemoteTracks(participants, this.join.participantId, focusedShare(participants, selectedShare)),
    );

    if (plan.close.length) {
      const transceivers: RTCRtpTransceiver[] = [];
      for (const key of plan.close) {
        const t = this.pulled.get(key)!;
        this.pulled.delete(key);
        this.detachMedia(t);
        const tr = this.pc.getTransceivers().find((x) => x.mid === t.mid);
        if (tr) transceivers.push(tr);
      }
      await this.closeTransceivers(transceivers);
    }

    if (plan.pull.length) {
      const res = await this.sfu("POST", "tracks/new", {
        tracks: plan.pull.map((t) => ({ location: "remote", sessionId: t.sessionId, trackName: t.trackName })),
      });
      let failed = false;
      for (const r of res.tracks ?? []) {
        const ref = plan.pull.find((t) => t.sessionId === r.sessionId && t.trackName === r.trackName);
        if (!ref) continue;
        if (r.errorCode || !r.mid) {
          failed = true;
          console.warn("[vapor-talk] pull failed", ref.key, r.errorCode, r.errorDescription);
          continue;
        }
        this.pullRetries = PULL_RETRIES;
        this.pulled.set(ref.key, { ...ref, mid: r.mid });
      }
      if (res.requiresImmediateRenegotiation && res.sessionDescription) {
        await this.pc.setRemoteDescription(res.sessionDescription);
        // SFU は閉じたトラックの m-line（mid）を使い回すことがある。閉じるときに inactive にした
        // transceiver のままだと answer も inactive になって届かないので、受信に戻す
        const mids = new Set((res.tracks ?? []).map((t) => t.mid));
        for (const tr of this.pc.getTransceivers()) {
          if (tr.mid && mids.has(tr.mid) && tr.direction === "inactive") tr.direction = "recvonly";
        }
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        await this.sfu("PUT", "renegotiate", {
          sessionDescription: { type: "answer", sdp: this.pc.localDescription!.sdp },
        });
      }
      // 相手の push 直後などで失敗したものは少し待って取り直す
      if (failed && this.pullRetries-- > 0) {
        setTimeout(() => this.scheduleSync(), 1500);
      }
    }
  }

  private async closeTransceivers(transceivers: RTCRtpTransceiver[]) {
    const pc = this.pc;
    const mids = transceivers.map((t) => t.mid).filter((m): m is string => !!m);
    if (!pc || pc.signalingState === "closed" || mids.length === 0) return;
    for (const t of transceivers) t.direction = "inactive";
    await pc.setLocalDescription(await pc.createOffer());
    const res = await this.sfu("PUT", "tracks/close", {
      tracks: mids.map((mid) => ({ mid })),
      sessionDescription: { type: "offer", sdp: pc.localDescription!.sdp },
      force: false,
    });
    if (res.sessionDescription) await pc.setRemoteDescription(res.sessionDescription);
  }

  private onTrack(e: RTCTrackEvent) {
    const mid = e.transceiver.mid;
    const ref = [...this.pulled.values()].find((t) => t.mid === mid);
    if (!ref) return;
    const stream = new MediaStream([e.track]);
    const current = this.state.media[ref.participantId] ?? {};
    this.set({ media: { ...this.state.media, [ref.participantId]: { ...current, [ref.kind]: stream } } });
    if (ref.kind === "mic") this.watchLevel(ref.participantId, stream);
  }

  private detachMedia(t: RemoteTrackRef) {
    const current = this.state.media[t.participantId];
    if (!current) return;
    const { [t.kind]: _, ...rest } = current;
    this.set({ media: { ...this.state.media, [t.participantId]: rest } });
    if (t.kind === "mic") this.unwatchLevel(t.participantId);
  }

  // --- 発話検出 ---

  private watchLevel(participantId: string, stream: MediaStream) {
    if (!this.audioCtx) return;
    this.unwatchLevel(participantId);
    const source = this.audioCtx.createMediaStreamSource(stream);
    const analyser = this.audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    this.analysers.set(participantId, { analyser, source });
  }

  private unwatchLevel(participantId: string) {
    const a = this.analysers.get(participantId);
    if (!a) return;
    a.source.disconnect();
    this.analysers.delete(participantId);
  }

  private updateSpeaking() {
    const buf = this.levelBuf;
    const muted = new Set(this.state.participants.filter((p) => p.muted).map((p) => p.id));
    const next = new Set<string>();
    for (const [id, { analyser }] of this.analysers) {
      if (muted.has(id)) continue;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      if (Math.sqrt(sum / buf.length) > SPEAKING_THRESHOLD) next.add(id);
    }
    const prev = this.speaking.get();
    if (next.size === prev.size && [...next].every((id) => prev.has(id))) return;
    this.speaking.set(next);
  }

  // --- 帯域の統計 ---

  private pollStats(active: boolean) {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.lastSample = null;
    if (!active || this.state.status === "ended") return;
    const tick = async () => {
      if (!this.pc) return;
      const sample = sampleStats((await this.pc.getStats()).values() as Iterable<Record<string, unknown>>, performance.now());
      if (this.lastSample) this.stats.set(bandwidth(this.lastSample, sample));
      this.lastSample = sample;
    };
    void tick();
    this.statsTimer = setInterval(() => void tick(), STATS_INTERVAL_MS);
  }
}

function upsert(list: Participant[], p: Participant): Participant[] {
  const i = list.findIndex((x) => x.id === p.id);
  if (i === -1) return [...list, p];
  const next = list.slice();
  next[i] = p;
  return next;
}

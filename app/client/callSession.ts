import {
  CloseCode,
  TERMINAL_CLOSE_CODES,
  type ClientMessage,
  type Participant,
  type PublishedTrack,
  type ServerMessage,
  type TrackKind,
} from "../domain/protocol";
import { desiredRemoteTracks, planTrackSync, type RemoteTrackRef } from "./trackPlan";

/**
 * 1回の通話。ルームの WebSocket（在室・公開トラックの共有）と、
 * SFU への RTCPeerConnection（音声・画面の送受信）を1本ずつ持つ。
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
    muted: false,
    sharing: false,
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
  private micStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private screenSeq = 0;

  private pulled = new Map<string, PulledTrack>();
  private pullRetries = PULL_RETRIES;

  private audioCtx: AudioContext | null = null;
  private analysers = new Map<string, { analyser: AnalyserNode; source: MediaStreamAudioSourceNode }>();
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private levelBuf = new Float32Array(512);
  private speaking: Speaking = new Set();
  private speakingListeners = new Set<() => void>();

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

  subscribeSpeaking = (fn: () => void) => {
    this.speakingListeners.add(fn);
    return () => this.speakingListeners.delete(fn);
  };

  getSpeaking = () => this.speaking;

  private set(patch: Partial<CallState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  // --- lifecycle ---

  /** 入室。ボタン押下から呼ぶこと（マイク許可と音声の自動再生のため）。 */
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

      try {
        this.micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch {
        // マイクが無い・拒否された場合は聞き専で入る
        this.micStream = null;
      }

      this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, bundlePolicy: "max-bundle" });
      this.pc.ontrack = (e) => this.onTrack(e);
      this.pc.onconnectionstatechange = () => {
        if (this.pc?.connectionState === "failed") this.fail("通話サーバーとの接続が切れました");
      };

      const mic = this.micStream?.getAudioTracks()[0];
      if (mic) {
        await this.enqueue(() => this.pushTracks([{ track: mic, trackName: "mic", kind: "mic" }]));
        this.watchLevel(this.join.participantId, this.micStream!);
      }
      this.set({ micAvailable: !!mic, muted: !mic });
      this.levelTimer = setInterval(() => this.updateSpeaking(), 120);

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

  async startScreenShare(): Promise<void> {
    if (this.state.sharing || !this.join) return;
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
    const tracks: { track: MediaStreamTrack; trackName: string; kind: TrackKind }[] = [
      { track: video, trackName: `screen-${seq}`, kind: "screen" },
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
        break;
      case "joined":
      case "updated":
        this.set({ participants: upsert(this.state.participants, msg.participant) });
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

  private async pushTracks(tracks: { track: MediaStreamTrack; trackName: string; kind: TrackKind }[]) {
    const pc = this.pc!;
    const transceivers = tracks.map((t) => pc.addTransceiver(t.track, { direction: "sendonly" }));
    await pc.setLocalDescription(await pc.createOffer());
    const res = await this.sfu("POST", "tracks/new", {
      sessionDescription: { type: "offer", sdp: pc.localDescription!.sdp },
      tracks: transceivers.map((tr, i) => ({ location: "local", mid: tr.mid, trackName: tracks[i].trackName })),
    });
    await pc.setRemoteDescription(res.sessionDescription!);
    tracks.forEach((t, i) => this.local.push({ ...t, transceiver: transceivers[i] }));
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
    const plan = planTrackSync(this.pulled, desiredRemoteTracks(this.state.participants, this.join.participantId));

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
    if (next.size === this.speaking.size && [...next].every((id) => this.speaking.has(id))) return;
    this.speaking = next;
    for (const fn of this.speakingListeners) fn();
  }
}

function upsert(list: Participant[], p: Participant): Participant[] {
  const i = list.findIndex((x) => x.id === p.id);
  if (i === -1) return [...list, p];
  const next = list.slice();
  next[i] = p;
  return next;
}

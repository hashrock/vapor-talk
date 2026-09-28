import { DurableObject } from "cloudflare:workers";
import { CloseCode, parseClientMessage, type Participant, type Role, type ServerMessage } from "./domain/protocol";
import { MAX_SPEAKERS, applyRoleCommand, applyUpdate, initialRole, speakerCount, type StageRules } from "./domain/stage";
import type { Bindings } from "./global";

/** ルーム作成時に init で保存する設定。無い（未作成・削除済み・期限切れ）なら接続を断る。 */
export interface RoomConfig {
  maxParticipants: number;
  expiresAt: string;
  /** ホスト（作成者）がいるルームか。この項目より前に作ったルームは Web 製なので true 扱い */
  hosted?: boolean;
}

/** Worker が WebSocket 接続を渡すときに付ける参加者情報（チケット検証済み）。JSON。 */
export const PARTICIPANT_HEADER = "X-Participant";
export interface ConnectingParticipant {
  id: string;
  name: string;
  sessionId: string;
  userId: string | null;
  host: boolean;
  invitedRole: Role | null;
}

/** WebSocket の attachment に持つ参加者。userId は他の参加者には配らない。 */
interface Member extends Participant {
  userId: string | null;
}

/** ホストがスピーカーにしたユーザー（userId）。入り直してもスピーカーに戻す */
const GRANTS_KEY = "grants";

/**
 * 1ルーム = 1インスタンス。参加者の在室状態と公開トラックを WebSocket で配る。
 * 音声・映像そのものは SFU を通るのでここは通らない。
 * Hibernation API を使い、参加者の状態は各 WebSocket の attachment に持つ。
 */
export class RoomDO extends DurableObject<Bindings> {
  /** undefined = まだ storage から読んでいない */
  private config: RoomConfig | null | undefined;
  private grants: Set<string> | undefined;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    // ハートビートはインスタンスを起こさずに返す
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const config = await this.loadConfig();
    if (!config || Date.parse(config.expiresAt) <= Date.now()) return new Response("Gone", { status: 410 });
    const joining = JSON.parse(request.headers.get(PARTICIPANT_HEADER) ?? "null") as ConnectingParticipant | null;
    if (!joining) return new Response("Bad request", { status: 400 });

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);

    // 同じ参加者の再接続なら古い接続を置き換える（参加者数には数えない）
    let replaced: Member | null = null;
    const others: Member[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const p = ws === server ? null : this.memberOf(ws);
      if (!p) continue;
      if (p.id !== joining.id) {
        others.push(p);
        continue;
      }
      replaced = p;
      ws.serializeAttachment(null);
      this.dismiss(ws, CloseCode.Replaced, "replaced by a new connection");
    }

    if (others.length >= config.maxParticipants) {
      this.dismiss(server, CloseCode.RoomFull, "room is full");
      return new Response(null, { status: 101, webSocket: client });
    }

    // 再接続ならロールと挙手を引き継ぐ。公開トラックとミュートは、クライアントが welcome を受けたら送り直す
    const grants = await this.loadGrants();
    const role =
      replaced?.role ??
      initialRole(
        { host: joining.host, invitedRole: joining.invitedRole, granted: !!joining.userId && grants.has(joining.userId) },
        speakerCount(others),
        this.rules(config).maxSpeakers,
      );
    const member: Member = {
      id: joining.id,
      name: joining.name,
      sessionId: joining.sessionId,
      userId: joining.userId,
      host: joining.host,
      loggedIn: !!joining.userId,
      role,
      handRaised: replaced?.handRaised ?? false,
      tracks: [],
      muted: role === "listener",
      joinedAt: replaced?.joinedAt ?? Date.now(),
    };
    server.serializeAttachment(member);
    this.send(server, { type: "welcome", participants: [...others, member].map(toPublic), expiresAt: config.expiresAt });
    this.broadcast({ type: "joined", participant: toPublic(member) }, server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    const msg = parseClientMessage(message);
    const p = this.memberOf(ws);
    if (!msg || msg.type === "ping" || !p) return;
    if (msg.type === "update") {
      this.save(ws, { ...p, ...applyUpdate(p, msg) });
      return;
    }

    const config = await this.loadConfig();
    if (!config) return;
    const sockets = new Map<string, WebSocket>();
    const members: Member[] = [];
    for (const s of this.ctx.getWebSockets()) {
      const m = this.memberOf(s);
      if (!m) continue;
      sockets.set(m.id, s);
      members.push(m);
    }
    for (const changed of applyRoleCommand(p, msg, members, this.rules(config))) {
      const before = members.find((m) => m.id === changed.id)!;
      if (before.role !== changed.role && before.userId) await this.setGrant(before.userId, changed.role === "speaker");
      this.save(sockets.get(changed.id)!, { ...before, ...changed });
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.leave(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.leave(ws);
  }

  async alarm(): Promise<void> {
    await this.destroy(CloseCode.RoomExpired, "room expired");
  }

  // --- RPC（Worker から呼ぶ） ---

  async init(config: RoomConfig): Promise<void> {
    this.config = config;
    await this.ctx.storage.put("config", config);
    await this.ctx.storage.setAlarm(Date.parse(config.expiresAt));
  }

  participants(): Participant[] {
    return this.members().map(toPublic);
  }

  /** SFU にトラックを push してよいか（接続中のスピーカーだけ）。SFU 中継が push の前に聞く。 */
  canPublish(participantId: string): boolean {
    return this.members().some((m) => m.id === participantId && m.role === "speaker");
  }

  async deleteRoom(): Promise<void> {
    await this.destroy(CloseCode.RoomDeleted, "room deleted");
  }

  // --- internals ---

  private rules(config: RoomConfig): StageRules {
    return { hosted: config.hosted ?? true, maxSpeakers: MAX_SPEAKERS };
  }

  private async loadGrants(): Promise<Set<string>> {
    this.grants ??= new Set((await this.ctx.storage.get<string[]>(GRANTS_KEY)) ?? []);
    return this.grants;
  }

  private async setGrant(userId: string, granted: boolean) {
    const grants = await this.loadGrants();
    if (granted) grants.add(userId);
    else grants.delete(userId);
    await this.ctx.storage.put(GRANTS_KEY, [...grants]);
  }

  private members(): Member[] {
    return this.ctx
      .getWebSockets()
      .map((ws) => this.memberOf(ws))
      .filter((m) => m !== null);
  }

  private save(ws: WebSocket, m: Member) {
    ws.serializeAttachment(m);
    this.broadcast({ type: "updated", participant: toPublic(m) });
  }

  private async loadConfig(): Promise<RoomConfig | null> {
    if (this.config === undefined) this.config = (await this.ctx.storage.get<RoomConfig>("config")) ?? null;
    return this.config;
  }

  private async destroy(code: number, reason: string) {
    for (const ws of this.ctx.getWebSockets()) {
      ws.serializeAttachment(null);
      this.dismiss(ws, code, reason);
    }
    this.config = null;
    this.grants = undefined;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  private leave(ws: WebSocket) {
    const p = this.memberOf(ws);
    if (!p) return;
    ws.serializeAttachment(null);
    this.broadcast({ type: "left", id: p.id });
  }

  private memberOf(ws: WebSocket): Member | null {
    return (ws.deserializeAttachment() as Member | null) ?? null;
  }

  /** 退出させる。bye が正式な終了通知で、close フレームは届けば儲けもの（プロキシ次第で届かない）。 */
  private dismiss(ws: WebSocket, code: number, reason: string) {
    this.send(ws, { type: "bye", code });
    try {
      ws.close(code, reason);
    } catch {
      // すでに閉じている
    }
  }

  private send(ws: WebSocket, msg: ServerMessage | string) {
    try {
      ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
    } catch {
      // 切断済みのソケットは close ハンドラで片付く
    }
  }

  private broadcast(msg: ServerMessage, except?: WebSocket) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== except && this.memberOf(ws)) this.send(ws, data);
    }
  }
}

function toPublic({ userId: _, ...p }: Member): Participant {
  return p;
}

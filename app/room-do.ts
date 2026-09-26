import { DurableObject } from "cloudflare:workers";
import { CloseCode, parseClientMessage, type Participant, type ServerMessage } from "./domain/protocol";
import type { Bindings } from "./global";

/** ルーム作成時に init で保存する設定。無い（未作成・削除済み・期限切れ）なら接続を断る。 */
export interface RoomConfig {
  maxParticipants: number;
  expiresAt: string;
}

/** Worker が WebSocket 接続を渡すときに付ける参加者情報（チケット検証済み）。JSON。 */
export const PARTICIPANT_HEADER = "X-Participant";
export type ConnectingParticipant = Pick<Participant, "id" | "name" | "sessionId">;

/**
 * 1ルーム = 1インスタンス。参加者の在室状態と公開トラックを WebSocket で配る。
 * 音声・映像そのものは SFU を通るのでここは通らない。
 * Hibernation API を使い、参加者の状態は各 WebSocket の attachment に持つ。
 */
export class RoomDO extends DurableObject<Bindings> {
  /** undefined = まだ storage から読んでいない */
  private config: RoomConfig | null | undefined;

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
    let replaced: Participant | null = null;
    const others: Participant[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const p = ws === server ? null : this.participantOf(ws);
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

    // 公開トラックとミュートは、クライアントが welcome を受けたら送り直す
    const participant: Participant = { ...joining, tracks: [], muted: false, joinedAt: replaced?.joinedAt ?? Date.now() };
    server.serializeAttachment(participant);
    this.send(server, { type: "welcome", participants: [...others, participant], expiresAt: config.expiresAt });
    this.broadcast({ type: "joined", participant }, server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    const msg = parseClientMessage(message);
    const p = this.participantOf(ws);
    if (msg?.type !== "update" || !p) return;
    const next: Participant = { ...p, tracks: msg.tracks ?? p.tracks, muted: msg.muted ?? p.muted };
    ws.serializeAttachment(next);
    this.broadcast({ type: "updated", participant: next });
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
    return this.ctx
      .getWebSockets()
      .map((ws) => this.participantOf(ws))
      .filter((p) => p !== null);
  }

  async deleteRoom(): Promise<void> {
    await this.destroy(CloseCode.RoomDeleted, "room deleted");
  }

  // --- internals ---

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
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  private leave(ws: WebSocket) {
    const p = this.participantOf(ws);
    if (!p) return;
    ws.serializeAttachment(null);
    this.broadcast({ type: "left", id: p.id });
  }

  private participantOf(ws: WebSocket): Participant | null {
    return (ws.deserializeAttachment() as Participant | null) ?? null;
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
      if (ws !== except && this.participantOf(ws)) this.send(ws, data);
    }
  }
}

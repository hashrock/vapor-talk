import type { RoomDO } from "./room-do";
import type { StoredRoom } from "./db/rooms";
import type { SessionClaims } from "./lib/tokens";

export type Bindings = {
  DB: D1Database;
  ROOM: DurableObjectNamespace<RoomDO>;
  CALLS_APP_ID?: string;
  /** Realtime SFU の App トークン（secret） */
  CALLS_APP_TOKEN?: string;
  /** REST API の Bearer キー（secret）。未設定なら /api/v1 は 503。 */
  API_KEY?: string;
  /** 参加トークン・セッションチケットの署名鍵（secret） */
  TOKEN_SECRET: string;
};

export type Env = {
  Bindings: Bindings;
  Variables: {
    /** 認証ミドルウェアが読み込んだルーム（DELETE /api/v1/rooms/:id） */
    room?: StoredRoom | null;
    /** 検証済みのセッションチケット（SFU 中継） */
    claims?: SessionClaims;
  };
};

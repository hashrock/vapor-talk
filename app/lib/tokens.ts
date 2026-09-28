import { sign, verify } from "hono/jwt";
import type { Role } from "../domain/protocol";

/**
 * 外部サービスが発行する参加トークン（招待 URL の ?token=）。
 * guestAccess=false のルームにはこれが無いと入れない。name があれば表示名を固定する。
 * role はスピーカーとして入るかリスナーとして入るか（role の無い古いトークンはスピーカー）。
 */
export interface InviteClaims {
  typ: "invite";
  room: string;
  name: string | null;
  role: Role;
  exp: number;
}

/**
 * 入室時にサーバーが発行するセッションチケット。
 * WebSocket と SFU プロキシはこれで「どのルームの・どの参加者の・どの SFU セッションか」を確定する。
 */
export interface SessionClaims {
  typ: "session";
  room: string;
  pid: string;
  sid: string;
  name: string;
  /** ログイン中のユーザー（未ログインは null） */
  uid: string | null;
  /** ルームの作成者 */
  host: boolean;
  /** 参加トークンで指定されたロール（トークンなしは null）。今のロールは RoomDO が持つ */
  invitedRole: Role | null;
  exp: number;
}

const ALG = "HS256";

export function signInvite(claims: Omit<InviteClaims, "typ">, secret: string): Promise<string> {
  return sign({ typ: "invite", ...claims }, secret, ALG);
}

export function signSession(claims: Omit<SessionClaims, "typ">, secret: string): Promise<string> {
  return sign({ typ: "session", ...claims }, secret, ALG);
}

async function verifyTyped(token: string, secret: string): Promise<Record<string, unknown> | null> {
  try {
    return (await verify(token, secret, ALG)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function verifyInvite(token: string, secret: string, roomId: string): Promise<InviteClaims | null> {
  const p = await verifyTyped(token, secret);
  if (!p || p.typ !== "invite" || p.room !== roomId) return null;
  return { ...(p as unknown as InviteClaims), role: p.role === "listener" ? "listener" : "speaker" };
}

export async function verifySession(token: string, secret: string, roomId: string): Promise<SessionClaims | null> {
  const p = await verifyTyped(token, secret);
  if (!p || p.typ !== "session" || p.room !== roomId) return null;
  return p as unknown as SessionClaims;
}

import { sign, verify } from "hono/jwt";

/**
 * 外部サービスが発行する参加トークン（招待 URL の ?token=）。
 * guestAccess=false のルームにはこれが無いと入れない。name があれば表示名を固定する。
 */
export interface InviteClaims {
  typ: "invite";
  room: string;
  name: string | null;
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
  return p as unknown as InviteClaims;
}

export async function verifySession(token: string, secret: string, roomId: string): Promise<SessionClaims | null> {
  const p = await verifyTyped(token, secret);
  if (!p || p.typ !== "session" || p.room !== roomId) return null;
  return p as unknown as SessionClaims;
}

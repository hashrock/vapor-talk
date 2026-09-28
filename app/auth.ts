import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, getSignedCookie, setCookie, setSignedCookie } from "hono/cookie";
import type { Env } from "./global";
import type { SessionUser } from "./user";

const SESSION_COOKIE = "session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
const RETURN_TO_COOKIE = "return_to";

/** DEV_BYPASS_AUTH のとき、Google を通さずにこのユーザーとしてログインする。 */
export const DEV_USER = { email: "dev@localhost", name: "Dev User", avatarUrl: "" } as const;

/** 署名付き Cookie からログイン中のユーザーを c.var.user に入れる（未ログインは null）。 */
export const sessionMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  const raw = await getSignedCookie(c, c.env.SESSION_SECRET, SESSION_COOKIE);
  let user: SessionUser | null = null;
  if (raw) {
    try {
      user = JSON.parse(raw) as SessionUser;
    } catch {
      // 壊れた Cookie は未ログイン扱い
    }
  }
  c.set("user", user);
  await next();
};

export async function signIn(c: Context<Env>, user: SessionUser) {
  await setSignedCookie(c, SESSION_COOKIE, JSON.stringify(user), c.env.SESSION_SECRET, {
    path: "/",
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    maxAge: SESSION_MAX_AGE,
  });
}

export function signOut(c: Context<Env>) {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

/** サイト内のパス（"/r/xxx" など）だけを受け付ける。"//evil.example" のような外部への飛ばしは捨てる。 */
export function safePath(path: string | undefined): string | null {
  return path && path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\") ? path : null;
}

/** ログイン後に戻るページを覚えておく（Google から戻るまでの間だけ）。 */
export function rememberReturnTo(c: Context<Env>, path: string) {
  const p = safePath(path);
  if (!p) return;
  setCookie(c, RETURN_TO_COOKIE, p, {
    path: "/",
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    maxAge: 10 * 60,
  });
}

/** 覚えておいた戻り先を取り出して消す。無ければトップ。 */
export function takeReturnTo(c: Context<Env>): string {
  const p = safePath(getCookie(c, RETURN_TO_COOKIE));
  deleteCookie(c, RETURN_TO_COOKIE, { path: "/" });
  return p ?? "/";
}

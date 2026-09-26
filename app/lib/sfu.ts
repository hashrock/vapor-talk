/**
 * Cloudflare Realtime SFU の HTTP API。App トークンはサーバーから出さず、
 * ブラウザからの操作は /api/rooms/:id/sfu/* 経由で自分のセッションに限って中継する。
 */
const BASE = "https://rtc.live.cloudflare.com/v1/apps";

export interface SfuConfig {
  appId: string;
  appToken: string;
}

export function sfuConfig(env: { CALLS_APP_ID?: string; CALLS_APP_TOKEN?: string }): SfuConfig | null {
  if (!env.CALLS_APP_ID || !env.CALLS_APP_TOKEN) return null;
  return { appId: env.CALLS_APP_ID, appToken: env.CALLS_APP_TOKEN };
}

export async function sfuFetch(cfg: SfuConfig, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE}/${cfg.appId}${path}`, {
    method,
    headers: { Authorization: `Bearer ${cfg.appToken}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function createSfuSession(cfg: SfuConfig): Promise<string> {
  const res = await sfuFetch(cfg, "POST", "/sessions/new");
  if (!res.ok) throw new Error(`SFU session creation failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { sessionId?: string };
  if (!json.sessionId) throw new Error("SFU session creation returned no sessionId");
  return json.sessionId;
}

/** ブラウザから中継してよい SFU 操作（パスはセッション配下に固定）。 */
export const SFU_PROXY_ROUTES = {
  "tracks/new": { method: "POST", path: (sid: string) => `/sessions/${sid}/tracks/new` },
  renegotiate: { method: "PUT", path: (sid: string) => `/sessions/${sid}/renegotiate` },
  "tracks/close": { method: "PUT", path: (sid: string) => `/sessions/${sid}/tracks/close` },
} as const;

export type SfuProxyAction = keyof typeof SFU_PROXY_ROUTES;

export function isSfuProxyAction(s: string): s is SfuProxyAction {
  return Object.hasOwn(SFU_PROXY_ROUTES, s);
}

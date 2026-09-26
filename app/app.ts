import { Hono, type Context } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { sha256 } from "hono/utils/crypto";
import { timingSafeEqual } from "hono/utils/buffer";
import { inertia } from "@hono/inertia";
import { rootView } from "./root-view";
import type { Env } from "./global";
import {
  isExpired,
  newManageKey,
  newRoomId,
  normalizeDisplayName,
  parseCreateRoomInput,
  parseCreateTokenInput,
  type Room,
} from "./domain/room";
import { deleteRoomRow, findRoom, insertRoom } from "./db/rooms";
import { signInvite, signSession, verifyInvite, verifySession } from "./lib/tokens";
import { SFU_PROXY_ROUTES, createSfuSession, isSfuProxyAction, sfuConfig, sfuFetch } from "./lib/sfu";
import { PARTICIPANT_HEADER, type ConnectingParticipant } from "./room-do";

const app = new Hono<Env>();

/** セッションチケットの寿命（1回の通話の上限）。ルームの期限のほうが短ければそちら。 */
const SESSION_TTL_SEC = 12 * 60 * 60;

const origin = (c: Context<Env>) => new URL(c.req.url).origin;
const jsonBody = (c: Context<Env>): Promise<unknown> => c.req.json().catch(() => ({}));
const roomStub = (c: Context<Env>, id: string) => c.env.ROOM.getByName(id);

function publicRoom(c: Context<Env>, room: Room) {
  return {
    id: room.id,
    name: room.name,
    url: `${origin(c)}/r/${room.id}`,
    maxParticipants: room.maxParticipants,
    guestAccess: room.guestAccess,
    externalId: room.externalId,
    createdAt: room.createdAt,
    expiresAt: room.expiresAt,
  };
}

async function createRoom(c: Context<Env>, body: unknown) {
  const parsed = parseCreateRoomInput(body);
  if (!parsed.ok) return parsed;
  const now = new Date();
  const room: Room = {
    id: newRoomId(),
    name: parsed.value.name,
    maxParticipants: parsed.value.maxParticipants,
    guestAccess: parsed.value.guestAccess,
    externalId: parsed.value.externalId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + parsed.value.expiresInSec * 1000).toISOString(),
  };
  const manageKey = newManageKey();
  await Promise.all([
    insertRoom(c.env.DB, room, (await sha256(manageKey))!),
    roomStub(c, room.id).init({ maxParticipants: room.maxParticipants, expiresAt: room.expiresAt }),
  ]);
  return { ok: true as const, room, manageKey };
}

const isApiKey = (token: string, c: Context<Env>) => !!c.env.API_KEY && timingSafeEqual(token, c.env.API_KEY);

// --- REST API（外部連携） ---

const api = new Hono<Env>();

api.use("*", async (c, next) => {
  if (!c.env.API_KEY) return c.json({ error: "API is disabled (API_KEY is not configured)" }, 503);
  return next();
});

const requireApiKey = bearerAuth<Env>({ verifyToken: isApiKey });

/** 削除は API キーのほか、作成時に渡した管理キーでもできる。 */
const requireApiKeyOrManageKey = bearerAuth<Env>({
  verifyToken: async (token, c) => {
    if (await isApiKey(token, c)) return true;
    const room = await findRoom(c.env.DB, c.req.param("id")!);
    c.set("room", room);
    return !!room && timingSafeEqual((await sha256(token))!, room.manageKeyHash);
  },
});

api.post("/rooms", requireApiKey, async (c) => {
  const result = await createRoom(c, await jsonBody(c));
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json({ ...publicRoom(c, result.room), manageKey: result.manageKey }, 201);
});

api.get("/rooms/:id", requireApiKey, async (c) => {
  const room = await findRoom(c.env.DB, c.req.param("id"));
  if (!room || isExpired(room, new Date())) return c.json({ error: "Not found" }, 404);
  const participants = await roomStub(c, room.id).participants();
  return c.json({
    ...publicRoom(c, room),
    participants: participants.map((p) => ({ id: p.id, name: p.name, muted: p.muted, joinedAt: new Date(p.joinedAt).toISOString() })),
  });
});

api.delete("/rooms/:id", requireApiKeyOrManageKey, async (c) => {
  const id = c.req.param("id");
  const room = c.get("room") ?? (await findRoom(c.env.DB, id));
  if (!room) return c.json({ error: "Not found" }, 404);
  await Promise.all([deleteRoomRow(c.env.DB, id), roomStub(c, id).deleteRoom()]);
  return c.body(null, 204);
});

api.post("/rooms/:id/tokens", requireApiKey, async (c) => {
  const room = await findRoom(c.env.DB, c.req.param("id"));
  const now = new Date();
  if (!room || isExpired(room, now)) return c.json({ error: "Not found" }, 404);
  const parsed = parseCreateTokenInput(await jsonBody(c), room, now);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const exp = Math.floor(now.getTime() / 1000) + parsed.value.expiresInSec;
  const token = await signInvite({ room: room.id, name: parsed.value.name, exp }, c.env.TOKEN_SECRET);
  return c.json(
    {
      token,
      url: `${origin(c)}/r/${room.id}?token=${encodeURIComponent(token)}`,
      name: parsed.value.name,
      expiresAt: new Date(exp * 1000).toISOString(),
    },
    201,
  );
});

app.route("/api/v1", api);

// --- 通話用の内部 API（ブラウザから） ---

/** 入室: 参加可否を判定し、SFU セッションとセッションチケットを発行する。 */
app.post("/api/rooms/:id/join", async (c) => {
  const room = await findRoom(c.env.DB, c.req.param("id"));
  const now = new Date();
  if (!room) return c.json({ error: "ルームが見つかりません" }, 404);
  if (isExpired(room, now)) return c.json({ error: "ルームの有効期限が切れています" }, 410);

  const body = (await jsonBody(c)) as { name?: unknown; token?: unknown };
  let name = typeof body.name === "string" ? normalizeDisplayName(body.name) : null;
  if (typeof body.token === "string" && body.token) {
    const invite = await verifyInvite(body.token, c.env.TOKEN_SECRET, room.id);
    if (!invite) return c.json({ error: "参加トークンが無効か期限切れです" }, 403);
    if (invite.name) name = invite.name;
  } else if (!room.guestAccess) {
    return c.json({ error: "このルームへの参加には招待トークンが必要です" }, 403);
  }
  if (!name) return c.json({ error: "表示名を入力してください" }, 400);

  // 満員なら SFU セッションを作る前に断る（最終的な判定は WebSocket 接続時に RoomDO が行う）
  const participants = await roomStub(c, room.id).participants();
  if (participants.length >= room.maxParticipants) return c.json({ error: "ルームが満員です" }, 409);

  const sfu = sfuConfig(c.env);
  if (!sfu) return c.json({ error: "通話サーバーが設定されていません（CALLS_APP_ID / CALLS_APP_TOKEN）" }, 503);
  let sessionId: string;
  try {
    sessionId = await createSfuSession(sfu);
  } catch (e) {
    console.error(e);
    return c.json({ error: "通話サーバーに接続できませんでした" }, 502);
  }

  const participantId = crypto.randomUUID();
  const exp = Math.min(Math.floor(now.getTime() / 1000) + SESSION_TTL_SEC, Math.floor(Date.parse(room.expiresAt) / 1000));
  const ticket = await signSession({ room: room.id, pid: participantId, sid: sessionId, name, exp }, c.env.TOKEN_SECRET);
  return c.json({ participantId, ticket });
});

/** SFU への中継。チケットに書かれた自分のセッションだけを操作できる。 */
const requireSession = bearerAuth<Env>({
  verifyToken: async (token, c) => {
    const claims = await verifySession(token, c.env.TOKEN_SECRET, c.req.param("id")!);
    if (claims) c.set("claims", claims);
    return !!claims;
  },
});

app.on(["POST", "PUT"], "/api/rooms/:id/sfu/:action{.+}", requireSession, async (c) => {
  const action = c.req.param("action");
  if (!isSfuProxyAction(action)) return c.json({ error: "Not found" }, 404);
  const route = SFU_PROXY_ROUTES[action];
  if (c.req.method !== route.method) return c.json({ error: "Method not allowed" }, 405);
  const sfu = sfuConfig(c.env);
  if (!sfu) return c.json({ error: "SFU is not configured" }, 503);

  const body = await c.req.json().catch(() => undefined);
  const res = await sfuFetch(sfu, route.method, route.path(c.get("claims")!.sid), body);
  return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json" } });
});

/** ルームの WebSocket。チケットを検証してから RoomDO に渡す（期限・削除・定員は RoomDO が判定）。 */
app.get("/api/rooms/:id/ws", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") return c.text("Expected WebSocket", 426);
  const roomId = c.req.param("id");
  const claims = await verifySession(c.req.query("ticket") ?? "", c.env.TOKEN_SECRET, roomId);
  if (!claims) return c.text("Unauthorized", 401);

  const joining: ConnectingParticipant = { id: claims.pid, name: claims.name, sessionId: claims.sid };
  const headers = new Headers(c.req.raw.headers);
  headers.set(PARTICIPANT_HEADER, JSON.stringify(joining));
  return roomStub(c, roomId).fetch(new Request(c.req.raw.url, { headers }));
});

// --- Inertia pages ---

app.use(inertia({ rootView }));

const routes = app
  .get("/", (c) => c.render("Home", {}))
  .post("/rooms", async (c) => {
    // Web から作るルームは常にゲスト参加可
    const result = await createRoom(c, { ...((await jsonBody(c)) as object), guestAccess: true, externalId: null });
    if (!result.ok) return c.render("Home", { error: result.error }, { url: "/" });
    return c.render(
      "Rooms/Created",
      { room: publicRoom(c, result.room), manageKey: result.manageKey },
      { url: `/r/${result.room.id}/created` },
    );
  })
  // 作成直後ページのリロード（管理キーは一度しか見せない）
  .get("/r/:id/created", (c) => c.redirect(`/r/${c.req.param("id")}`))
  .get("/r/:id", async (c) => {
    const room = await findRoom(c.env.DB, c.req.param("id"));
    if (!room) {
      c.status(404);
      return c.render("Rooms/Unavailable", { reason: "not-found" as const });
    }
    if (isExpired(room, new Date())) {
      c.status(410);
      return c.render("Rooms/Unavailable", { reason: "expired" as const });
    }
    const token = c.req.query("token") ?? null;
    const invite = token ? await verifyInvite(token, c.env.TOKEN_SECRET, room.id) : null;
    return c.render("Rooms/Show", {
      room: publicRoom(c, room),
      invite: token ? { token, valid: !!invite, name: invite?.name ?? null } : null,
    });
  });

export default routes;

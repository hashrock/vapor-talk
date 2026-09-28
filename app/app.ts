import { Hono, type Context } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { sha256 } from "hono/utils/crypto";
import { timingSafeEqual } from "hono/utils/buffer";
import { inertia } from "@hono/inertia";
import { googleAuth } from "@hono/oauth-providers/google";
import { DEV_USER, rememberReturnTo, safePath, sessionMiddleware, signIn, signOut, takeReturnTo } from "./auth";
import { upsertUser } from "./db/users";
import { rootView } from "./root-view";
import type { Env } from "./global";
import {
  isExpired,
  isRecord,
  newManageKey,
  newRoomId,
  normalizeDisplayName,
  parseCreateRoomInput,
  parseCreateTokenInput,
  type Room,
} from "./domain/room";
import { deleteRoomRow, findRoom, insertRoom, listOwnedRooms } from "./db/rooms";
import { signInvite, signSession, verifyInvite, verifySession } from "./lib/tokens";
import { SFU_PROXY_ROUTES, createSfuSession, isSfuProxyAction, sfuConfig, sfuFetch } from "./lib/sfu";
import { PARTICIPANT_HEADER, type ConnectingParticipant } from "./room-do";
import type { Role } from "./domain/protocol";

const app = new Hono<Env>();

// ログイン状態は、ページのほか入室（スピーカーになれるか・ホストか）でも使う
app.use(sessionMiddleware);

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

async function createRoom(c: Context<Env>, body: unknown, ownerId: string | null) {
  const parsed = parseCreateRoomInput(body);
  if (!parsed.ok) return parsed;
  const now = new Date();
  const room: Room = {
    id: newRoomId(),
    name: parsed.value.name,
    maxParticipants: parsed.value.maxParticipants,
    guestAccess: parsed.value.guestAccess,
    externalId: parsed.value.externalId,
    ownerId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + parsed.value.expiresInSec * 1000).toISOString(),
  };
  const manageKey = newManageKey();
  await Promise.all([
    insertRoom(c.env.DB, room, (await sha256(manageKey))!),
    roomStub(c, room.id).init({ maxParticipants: room.maxParticipants, expiresAt: room.expiresAt, hosted: ownerId !== null }),
  ]);
  return { ok: true as const, room, manageKey };
}

async function destroyRoom(c: Context<Env>, id: string) {
  await Promise.all([deleteRoomRow(c.env.DB, id), roomStub(c, id).deleteRoom()]);
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
  const result = await createRoom(c, await jsonBody(c), null);
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json({ ...publicRoom(c, result.room), manageKey: result.manageKey }, 201);
});

api.get("/rooms/:id", requireApiKey, async (c) => {
  const room = await findRoom(c.env.DB, c.req.param("id"));
  if (!room || isExpired(room, new Date())) return c.json({ error: "Not found" }, 404);
  const participants = await roomStub(c, room.id).participants();
  return c.json({
    ...publicRoom(c, room),
    participants: participants.map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      muted: p.muted,
      joinedAt: new Date(p.joinedAt).toISOString(),
    })),
  });
});

api.delete("/rooms/:id", requireApiKeyOrManageKey, async (c) => {
  const id = c.req.param("id");
  const room = c.get("room") ?? (await findRoom(c.env.DB, id));
  if (!room) return c.json({ error: "Not found" }, 404);
  await destroyRoom(c, id);
  return c.body(null, 204);
});

api.post("/rooms/:id/tokens", requireApiKey, async (c) => {
  const room = await findRoom(c.env.DB, c.req.param("id"));
  const now = new Date();
  if (!room || isExpired(room, now)) return c.json({ error: "Not found" }, 404);
  const parsed = parseCreateTokenInput(await jsonBody(c), room, now);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const exp = Math.floor(now.getTime() / 1000) + parsed.value.expiresInSec;
  const token = await signInvite({ room: room.id, name: parsed.value.name, role: parsed.value.role, exp }, c.env.TOKEN_SECRET);
  return c.json(
    {
      token,
      url: `${origin(c)}/r/${room.id}?token=${encodeURIComponent(token)}`,
      name: parsed.value.name,
      role: parsed.value.role,
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
  let invitedRole: Role | null = null;
  if (typeof body.token === "string" && body.token) {
    const invite = await verifyInvite(body.token, c.env.TOKEN_SECRET, room.id);
    if (!invite) return c.json({ error: "参加トークンが無効か期限切れです" }, 403);
    if (invite.name) name = invite.name;
    invitedRole = invite.role;
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
  const user = c.get("user");
  const ticket = await signSession(
    {
      room: room.id,
      pid: participantId,
      sid: sessionId,
      name,
      uid: user?.id ?? null,
      host: !!user && room.ownerId === user.id,
      invitedRole,
      exp,
    },
    c.env.TOKEN_SECRET,
  );
  return c.json({ participantId, ticket });
});

function pushesLocalTrack(body: unknown): boolean {
  const tracks = isRecord(body) && Array.isArray(body.tracks) ? body.tracks : [];
  return tracks.some((t) => !isRecord(t) || t.location !== "remote");
}

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
  const claims = c.get("claims")!;
  // push（location: "local"）はスピーカーだけ。今のロールは RoomDO に聞く（チケットのロールは古くなりうる）
  if (action === "tracks/new" && pushesLocalTrack(body) && !(await roomStub(c, claims.room).canPublish(claims.pid))) {
    return c.json({ errorCode: "forbidden", errorDescription: "リスナーは送信できません" }, 403);
  }
  const res = await sfuFetch(sfu, route.method, route.path(claims.sid), body);
  return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json" } });
});

/** ルームの WebSocket。チケットを検証してから RoomDO に渡す（期限・削除・定員は RoomDO が判定）。 */
app.get("/api/rooms/:id/ws", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") return c.text("Expected WebSocket", 426);
  const roomId = c.req.param("id");
  const claims = await verifySession(c.req.query("ticket") ?? "", c.env.TOKEN_SECRET, roomId);
  if (!claims) return c.text("Unauthorized", 401);

  const joining: ConnectingParticipant = {
    id: claims.pid,
    name: claims.name,
    sessionId: claims.sid,
    userId: claims.uid ?? null,
    host: claims.host ?? false,
    invitedRole: claims.invitedRole ?? null,
  };
  const headers = new Headers(c.req.raw.headers);
  // ヘッダーは ASCII のみなので、日本語の表示名が入る JSON は URL エンコードして渡す
  headers.set(PARTICIPANT_HEADER, encodeURIComponent(JSON.stringify(joining)));
  return roomStub(c, roomId).fetch(new Request(c.req.raw.url, { headers }));
});

// --- ログイン（ルーム作成とスピーカーに必要。聞くだけならアカウント不要） ---

app.get(
  "/auth/google",
  async (c, next) => {
    // ?next= はログイン後に戻るページ（ルームから「ログインして挙手」したとき）
    const next_ = c.req.query("next");
    if (!c.env.DEV_BYPASS_AUTH) {
      // Google から戻ってくる（?code=）までの間、戻り先を Cookie に覚えておく
      if (next_ !== undefined) rememberReturnTo(c, next_);
      return next();
    }
    // ?as=alice で別のユーザー（alice@localhost）としてログインする。役割の確認用
    const as = c.req.query("as")?.replace(/[^a-z0-9_-]/gi, "").slice(0, 20);
    await signIn(c, await upsertUser(c.env.DB, as ? { email: `${as}@localhost`, name: as, avatarUrl: "" } : DEV_USER));
    return c.redirect(safePath(next_) ?? "/");
  },
  googleAuth({ scope: ["openid", "email", "profile"], prompt: "select_account" }),
  async (c) => {
    const google = c.get("user-google");
    if (!google?.email) return c.redirect("/?error=auth");
    const user = await upsertUser(c.env.DB, { email: google.email, name: google.name ?? google.email, avatarUrl: google.picture ?? "" });
    await signIn(c, user);
    return c.redirect(takeReturnTo(c));
  },
);

app.get("/auth/logout", (c) => {
  signOut(c);
  return c.redirect("/");
});

// --- Inertia pages ---

app.use(inertia<Env>()({ rootView, share: (c) => ({ user: c.get("user") }) }));

const routes = app
  .get("/", (c) => c.render("Home", {}))
  .get("/rooms", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/auth/google");
    const rooms = await listOwnedRooms(c.env.DB, user.id, new Date());
    return c.render("Rooms/Index", { rooms: rooms.map((r) => publicRoom(c, r)) });
  })
  .post("/rooms", async (c) => {
    const user = c.get("user");
    if (!user) return c.redirect("/auth/google");
    // Web から作るルームは常にゲスト参加可
    const result = await createRoom(c, { ...((await jsonBody(c)) as object), guestAccess: true, externalId: null }, user.id);
    if (!result.ok) return c.render("Home", { error: result.error }, { url: "/" });
    return c.render("Rooms/Created", { room: publicRoom(c, result.room) }, { url: `/r/${result.room.id}/created` });
  })
  .delete("/rooms/:id", async (c) => {
    const user = c.get("user");
    const room = await findRoom(c.env.DB, c.req.param("id"));
    if (!user || !room || room.ownerId !== user.id) return c.notFound();
    await destroyRoom(c, room.id);
    return c.redirect("/rooms");
  })
  // 作成直後ページのリロード
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
    const user = c.get("user");
    return c.render("Rooms/Show", {
      room: publicRoom(c, room),
      invite: token ? { token, valid: !!invite, name: invite?.name ?? null } : null,
      isOwner: !!user && room.ownerId === user.id,
      /** ホストのいるルーム（挙手できる） */
      hosted: room.ownerId !== null,
    });
  });

export default routes;

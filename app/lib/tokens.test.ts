import { describe, expect, it } from "vitest";
import { signInvite, signSession, verifyInvite, verifySession } from "./tokens";

const secret = "test-secret";
const exp = Math.floor(Date.now() / 1000) + 60;

describe("tokens", () => {
  it("招待トークンは発行したルームでだけ有効", async () => {
    const t = await signInvite({ room: "a", name: "Alice", role: "speaker", exp }, secret);
    expect((await verifyInvite(t, secret, "a"))?.name).toBe("Alice");
    expect(await verifyInvite(t, secret, "b")).toBeNull();
    expect(await verifyInvite(t, "other-secret", "a")).toBeNull();
  });

  it("招待トークンとセッションチケットは取り違えられない", async () => {
    const invite = await signInvite({ room: "a", name: null, role: "speaker", exp }, secret);
    const session = await signSession({ room: "a", pid: "p", sid: "s", name: "n", uid: null, host: false, invitedRole: null, exp }, secret);
    expect(await verifySession(invite, secret, "a")).toBeNull();
    expect(await verifyInvite(session, secret, "a")).toBeNull();
    expect((await verifySession(session, secret, "a"))?.sid).toBe("s");
  });

  it("role の無い古い招待トークンはスピーカー扱い", async () => {
    const { sign } = await import("hono/jwt");
    const legacy = await sign({ typ: "invite", room: "a", name: null, exp }, secret, "HS256");
    expect((await verifyInvite(legacy, secret, "a"))?.role).toBe("speaker");
    const listener = await signInvite({ room: "a", name: null, role: "listener", exp }, secret);
    expect((await verifyInvite(listener, secret, "a"))?.role).toBe("listener");
  });

  it("期限切れは無効", async () => {
    const t = await signInvite({ room: "a", name: null, role: "speaker", exp: Math.floor(Date.now() / 1000) - 10 }, secret);
    expect(await verifyInvite(t, secret, "a")).toBeNull();
  });
});

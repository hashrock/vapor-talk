import { describe, expect, it } from "vitest";
import { signInvite, signSession, verifyInvite, verifySession } from "./tokens";

const secret = "test-secret";
const exp = Math.floor(Date.now() / 1000) + 60;

describe("tokens", () => {
  it("招待トークンは発行したルームでだけ有効", async () => {
    const t = await signInvite({ room: "a", name: "Alice", exp }, secret);
    expect((await verifyInvite(t, secret, "a"))?.name).toBe("Alice");
    expect(await verifyInvite(t, secret, "b")).toBeNull();
    expect(await verifyInvite(t, "other-secret", "a")).toBeNull();
  });

  it("招待トークンとセッションチケットは取り違えられない", async () => {
    const invite = await signInvite({ room: "a", name: null, exp }, secret);
    const session = await signSession({ room: "a", pid: "p", sid: "s", name: "n", exp }, secret);
    expect(await verifySession(invite, secret, "a")).toBeNull();
    expect(await verifyInvite(session, secret, "a")).toBeNull();
    expect((await verifySession(session, secret, "a"))?.sid).toBe("s");
  });

  it("期限切れは無効", async () => {
    const t = await signInvite({ room: "a", name: null, exp: Math.floor(Date.now() / 1000) - 10 }, secret);
    expect(await verifyInvite(t, secret, "a")).toBeNull();
  });
});

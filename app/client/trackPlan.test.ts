import { describe, expect, it } from "vitest";
import { desiredRemoteTracks, focusedShare, planTrackSync, remoteKey } from "./trackPlan";
import type { Participant } from "../domain/protocol";

const p = (id: string, sessionId: string, names: string[]): Participant => ({
  id,
  name: id,
  sessionId,
  muted: false,
  joinedAt: 0,
  role: "speaker",
  host: false,
  loggedIn: false,
  handRaised: false,
  tracks: names.map((trackName) => ({ trackName, kind: trackName === "mic" ? "mic" : "screen" })),
});

describe("desiredRemoteTracks", () => {
  it("自分のトラックは含めない", () => {
    const d = desiredRemoteTracks([p("me", "s0", ["mic"]), p("a", "s1", ["mic", "screen"])], "me", "a");
    expect(d.map((t) => t.key)).toEqual(["a/mic", "a/screen"]);
  });

  it("画面はステージに出している人の分だけ pull する（音声は全員分）", () => {
    const ps = [p("a", "s1", ["mic", "screen"]), p("b", "s2", ["mic", "screen"])];
    expect(desiredRemoteTracks(ps, "me", "b").map((t) => t.key)).toEqual(["a/mic", "b/mic", "b/screen"]);
    expect(desiredRemoteTracks(ps, "me", null).map((t) => t.key)).toEqual(["a/mic", "b/mic"]);
  });
});

describe("focusedShare", () => {
  const ps = [p("a", "s1", ["mic"]), p("b", "s2", ["mic", "screen"]), p("c", "s3", ["screen"])];
  it("選んだ人が共有中ならその人", () => expect(focusedShare(ps, "c")).toBe("c"));
  it("選んだ人が共有していなければ最初の共有者", () => {
    expect(focusedShare(ps, "a")).toBe("b");
    expect(focusedShare(ps, null)).toBe("b");
  });
  it("誰も共有していなければ null", () => expect(focusedShare([p("a", "s1", ["mic"])], "a")).toBeNull());
});

describe("planTrackSync", () => {
  it("新しいトラックを pull し、消えたトラックを close する", () => {
    const current = new Map([[remoteKey("a", "mic"), { sessionId: "s1" }], [remoteKey("b", "screen"), { sessionId: "s2" }]]);
    const desired = desiredRemoteTracks([p("a", "s1", ["mic", "screen"])], "me", "a");
    const plan = planTrackSync(current, desired);
    expect(plan.pull.map((t) => t.key)).toEqual(["a/screen"]);
    expect(plan.close).toEqual(["b/screen"]);
  });

  it("セッションが変わったトラックは取り直す", () => {
    const current = new Map([[remoteKey("a", "mic"), { sessionId: "old" }]]);
    const plan = planTrackSync(current, desiredRemoteTracks([p("a", "new", ["mic"])], "me", null));
    expect(plan.close).toEqual(["a/mic"]);
    expect(plan.pull.map((t) => t.sessionId)).toEqual(["new"]);
  });

  it("変化がなければ何もしない", () => {
    const desired = desiredRemoteTracks([p("a", "s1", ["mic"])], "me", null);
    const current = new Map(desired.map((d) => [d.key, d]));
    expect(planTrackSync(current, desired)).toEqual({ pull: [], close: [] });
  });
});

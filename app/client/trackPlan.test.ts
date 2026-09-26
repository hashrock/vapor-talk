import { describe, expect, it } from "vitest";
import { desiredRemoteTracks, planTrackSync, remoteKey } from "./trackPlan";
import type { Participant } from "../domain/protocol";

const p = (id: string, sessionId: string, names: string[]): Participant => ({
  id,
  name: id,
  sessionId,
  muted: false,
  joinedAt: 0,
  tracks: names.map((trackName) => ({ trackName, kind: trackName === "mic" ? "mic" : "screen" })),
});

describe("desiredRemoteTracks", () => {
  it("自分のトラックは含めない", () => {
    const d = desiredRemoteTracks([p("me", "s0", ["mic"]), p("a", "s1", ["mic", "screen"])], "me");
    expect(d.map((t) => t.key)).toEqual(["a/mic", "a/screen"]);
  });
});

describe("planTrackSync", () => {
  it("新しいトラックを pull し、消えたトラックを close する", () => {
    const current = new Map([[remoteKey("a", "mic"), { sessionId: "s1" }], [remoteKey("b", "screen"), { sessionId: "s2" }]]);
    const desired = desiredRemoteTracks([p("a", "s1", ["mic", "screen"])], "me");
    const plan = planTrackSync(current, desired);
    expect(plan.pull.map((t) => t.key)).toEqual(["a/screen"]);
    expect(plan.close).toEqual(["b/screen"]);
  });

  it("セッションが変わったトラックは取り直す", () => {
    const current = new Map([[remoteKey("a", "mic"), { sessionId: "old" }]]);
    const plan = planTrackSync(current, desiredRemoteTracks([p("a", "new", ["mic"])], "me"));
    expect(plan.close).toEqual(["a/mic"]);
    expect(plan.pull.map((t) => t.sessionId)).toEqual(["new"]);
  });

  it("変化がなければ何もしない", () => {
    const desired = desiredRemoteTracks([p("a", "s1", ["mic"])], "me");
    const current = new Map(desired.map((d) => [d.key, d]));
    expect(planTrackSync(current, desired)).toEqual({ pull: [], close: [] });
  });
});

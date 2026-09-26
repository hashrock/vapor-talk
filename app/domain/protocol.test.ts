import { describe, expect, it } from "vitest";
import { parseClientMessage } from "./protocol";

describe("parseClientMessage", () => {
  it("正しい update を受け付ける", () => {
    expect(parseClientMessage(JSON.stringify({ type: "update", muted: true, tracks: [{ trackName: "mic", kind: "mic" }] }))).toEqual({
      type: "update",
      muted: true,
      tracks: [{ trackName: "mic", kind: "mic" }],
    });
  });

  it("不正な JSON・未知の種別・不正なトラックは null", () => {
    expect(parseClientMessage("{")).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "kick" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "update", tracks: [{ trackName: "x", kind: "video" }] }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "update", muted: "no" }))).toBeNull();
  });
});

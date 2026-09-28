import { describe, expect, it } from "vitest";
import { bandwidth, sampleStats } from "./stats";

const reports = (audioOut: number, videoIn: number, sent: number, received: number) => [
  { type: "outbound-rtp", kind: "audio", bytesSent: audioOut },
  { type: "inbound-rtp", kind: "video", bytesReceived: videoIn },
  { type: "transport", bytesSent: sent, bytesReceived: received },
  { type: "candidate-pair", nominated: true, currentRoundTripTime: 0.042 },
  { type: "candidate-pair", nominated: false, currentRoundTripTime: 0.5 },
];

describe("bandwidth", () => {
  it("2 回のサンプルの差から kbps を出す", () => {
    const a = sampleStats(reports(0, 0, 0, 0), 0);
    const b = sampleStats(reports(5_000, 125_000, 6_000, 130_000), 1000);
    expect(bandwidth(a, b)).toEqual({
      audioOut: 40,
      audioIn: 0,
      videoOut: 0,
      videoIn: 1000,
      totalOut: 48,
      totalIn: 1040,
      rttMs: 42,
      sentBytes: 6_000,
      receivedBytes: 130_000,
    });
  });

  it("トラックが閉じてカウンタが減っても負の速度にしない", () => {
    const a = sampleStats(reports(0, 100_000, 0, 0), 0);
    const b = sampleStats(reports(0, 0, 0, 0), 1000);
    expect(bandwidth(a, b).videoIn).toBe(0);
  });
});

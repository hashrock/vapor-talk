import { describe, expect, it } from "vitest";
import { enableOpusDtx } from "./sdp";

const sdp = [
  "v=0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111 63",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "a=rtpmap:63 red/48000/2",
  "a=fmtp:63 111/111",
  "m=video 9 UDP/TLS/RTP/SAVPF 96",
  "a=rtpmap:96 VP8/90000",
  "",
].join("\r\n");

describe("enableOpusDtx", () => {
  it("Opus の fmtp に usedtx=1 を足し、ほかのコーデックは触らない", () => {
    const out = enableOpusDtx(sdp);
    expect(out).toContain("a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1\r\n");
    expect(out).toContain("a=fmtp:63 111/111\r\n");
    expect(out).toContain("a=rtpmap:96 VP8/90000");
  });

  it("2 回かけても重ならない", () => {
    expect(enableOpusDtx(enableOpusDtx(sdp))).toBe(enableOpusDtx(sdp));
  });

  it("fmtp 行の無い Opus には足す", () => {
    const out = enableOpusDtx("m=audio 9 UDP/TLS/RTP/SAVPF 111\na=rtpmap:111 opus/48000/2\n");
    expect(out).toBe("m=audio 9 UDP/TLS/RTP/SAVPF 111\na=rtpmap:111 opus/48000/2\na=fmtp:111 usedtx=1\n");
  });

  it("usedtx=0 が指定されていれば尊重する", () => {
    const s = "a=rtpmap:111 opus/48000/2\r\na=fmtp:111 usedtx=0\r\n";
    expect(enableOpusDtx(s)).toBe(s);
  });

  it("Opus が無ければそのまま", () => {
    expect(enableOpusDtx("m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\n")).toBe("m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\n");
  });
});

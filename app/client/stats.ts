/**
 * RTCPeerConnection.getStats() から通話の帯域を集計する。
 * 1 本の PeerConnection（bundle）で全トラックを送受信しているので、
 * 累計は transport の、種類別の速度は rtp の byte カウンタから出す。
 */

/** getStats() の 1 回分から必要な値だけを抜いたもの。 */
export interface StatsSample {
  at: number;
  /** "audio:out" のように `${kind}:${向き}` ごとの byte 数（rtp ストリームの合計） */
  rtpBytes: Record<string, number>;
  sentBytes: number;
  receivedBytes: number;
  rttMs: number | null;
}

export interface BandwidthStats {
  /** kbps */
  audioOut: number;
  audioIn: number;
  videoOut: number;
  videoIn: number;
  totalOut: number;
  totalIn: number;
  rttMs: number | null;
  /** 接続してからの累計（byte） */
  sentBytes: number;
  receivedBytes: number;
}

type Report = Record<string, unknown>;

export function sampleStats(reports: Iterable<Report>, at: number): StatsSample {
  const rtpBytes: Record<string, number> = {};
  let sentBytes = 0;
  let receivedBytes = 0;
  let rttMs: number | null = null;
  for (const r of reports) {
    if (r.type === "outbound-rtp" || r.type === "inbound-rtp") {
      const key = `${r.kind}:${r.type === "outbound-rtp" ? "out" : "in"}`;
      const bytes = Number(r.type === "outbound-rtp" ? r.bytesSent : r.bytesReceived) || 0;
      rtpBytes[key] = (rtpBytes[key] ?? 0) + bytes;
    } else if (r.type === "transport") {
      sentBytes += Number(r.bytesSent) || 0;
      receivedBytes += Number(r.bytesReceived) || 0;
    } else if (r.type === "candidate-pair" && r.nominated && typeof r.currentRoundTripTime === "number") {
      rttMs = Math.round(r.currentRoundTripTime * 1000);
    }
  }
  return { at, rtpBytes, sentBytes, receivedBytes, rttMs };
}

/** 2 回のサンプルの差から速度を出す。トラックが閉じてカウンタが減った分は 0 とみなす。 */
export function bandwidth(prev: StatsSample, curr: StatsSample): BandwidthStats {
  const sec = Math.max((curr.at - prev.at) / 1000, 0.001);
  const kbps = (now: number, before: number) => Math.round((Math.max(now - before, 0) * 8) / 1000 / sec);
  const rtp = (key: string) => kbps(curr.rtpBytes[key] ?? 0, prev.rtpBytes[key] ?? 0);
  return {
    audioOut: rtp("audio:out"),
    audioIn: rtp("audio:in"),
    videoOut: rtp("video:out"),
    videoIn: rtp("video:in"),
    totalOut: kbps(curr.sentBytes, prev.sentBytes),
    totalIn: kbps(curr.receivedBytes, prev.receivedBytes),
    rttMs: curr.rttMs,
    sentBytes: curr.sentBytes,
    receivedBytes: curr.receivedBytes,
  };
}

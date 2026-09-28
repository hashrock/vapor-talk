/**
 * Opus の DTX（無音の間は送らない）を SDP で有効にする。
 *
 * 送る側のエンコーダは、交渉した Opus の fmtp（usedtx=1）で DTX を使うかを決める。
 * SFU の SDP には入っていないので、自分の offer / answer と、SFU から来る offer / answer の
 * 両方に足す（片方だけだと再交渉のたびに外れる）。
 */
export function enableOpusDtx(sdp: string): string {
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  const lines = sdp.split(eol);
  const opus = new Set<string>();
  for (const line of lines) {
    const m = /^a=rtpmap:(\d+) opus\/48000/i.exec(line);
    if (m) opus.add(m[1]);
  }
  if (opus.size === 0) return sdp;

  const withFmtp = new Set<string>();
  const out = lines.map((line) => {
    const m = /^a=fmtp:(\d+) (.*)$/.exec(line);
    if (!m || !opus.has(m[1])) return line;
    withFmtp.add(m[1]);
    return /(^|;)\s*usedtx=/.test(m[2]) ? line : `${line};usedtx=1`;
  });

  // fmtp 行が無い Opus には rtpmap の直後に足す
  return out
    .flatMap((line) => {
      const m = /^a=rtpmap:(\d+) opus\/48000/i.exec(line);
      return m && !withFmtp.has(m[1]) ? [line, `a=fmtp:${m[1]} usedtx=1`] : [line];
    })
    .join(eol);
}

export function withOpusDtx<T extends RTCSessionDescriptionInit>(desc: T): T {
  return desc.sdp ? { ...desc, sdp: enableOpusDtx(desc.sdp) } : desc;
}

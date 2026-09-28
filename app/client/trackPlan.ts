import type { Participant, TrackKind } from "../domain/protocol";

/** pull しているリモートトラック1本。key は `${participantId}/${trackName}`。 */
export interface RemoteTrackRef {
  key: string;
  participantId: string;
  sessionId: string;
  trackName: string;
  kind: TrackKind;
}

export function remoteKey(participantId: string, trackName: string): string {
  return `${participantId}/${trackName}`;
}

/**
 * 画面共有中の人のうち、ステージに出す 1 人。選んだ人がまだ共有していればその人、
 * そうでなければ最初に見つかった共有者（自分を含む）。誰も共有していなければ null。
 */
export function focusedShare(participants: readonly Participant[], selected: string | null): string | null {
  const sharers = participants.filter((p) => p.tracks.some((t) => t.kind === "screen")).map((p) => p.id);
  return selected && sharers.includes(selected) ? selected : (sharers[0] ?? null);
}

/**
 * 自分以外の公開トラックのうち pull したいもの。音声は全員分、
 * 画面（映像と音声）はステージに出している 1 人分だけ（見ていない画面で帯域を使わない）。
 */
export function desiredRemoteTracks(participants: Iterable<Participant>, selfId: string, focused: string | null): RemoteTrackRef[] {
  const out: RemoteTrackRef[] = [];
  for (const p of participants) {
    if (p.id === selfId) continue;
    for (const t of p.tracks) {
      if (t.kind !== "mic" && p.id !== focused) continue;
      out.push({ key: remoteKey(p.id, t.trackName), participantId: p.id, sessionId: p.sessionId, trackName: t.trackName, kind: t.kind });
    }
  }
  return out;
}

/**
 * 今 pull しているもの（current）と欲しいもの（desired）の差分。
 * 同じ key でも sessionId が変わったら（参加者が入り直した）取り直す。
 */
export function planTrackSync(
  current: ReadonlyMap<string, { sessionId: string }>,
  desired: readonly RemoteTrackRef[],
): { pull: RemoteTrackRef[]; close: string[] } {
  const want = new Map(desired.map((d) => [d.key, d]));
  const pull: RemoteTrackRef[] = [];
  const close: string[] = [];
  for (const [key, cur] of current) {
    const d = want.get(key);
    if (!d || d.sessionId !== cur.sessionId) close.push(key);
  }
  for (const d of desired) {
    const cur = current.get(d.key);
    if (!cur || cur.sessionId !== d.sessionId) pull.push(d);
  }
  return { pull, close };
}

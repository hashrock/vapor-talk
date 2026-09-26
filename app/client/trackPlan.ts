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

/** 在室者の公開トラックのうち、自分以外のものを全部 pull したい。 */
export function desiredRemoteTracks(participants: Iterable<Participant>, selfId: string): RemoteTrackRef[] {
  const out: RemoteTrackRef[] = [];
  for (const p of participants) {
    if (p.id === selfId) continue;
    for (const t of p.tracks) {
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

/** ルームの WebSocket（RoomDO ⇔ ブラウザ）でやりとりするメッセージ。 */
import { isRecord } from "./room";

export type TrackKind = "mic" | "screen" | "screen-audio";

/** 参加者が SFU に push しているトラック。他の参加者は sessionId + trackName で pull する。 */
export interface PublishedTrack {
  trackName: string;
  kind: TrackKind;
}

export interface Participant {
  id: string;
  name: string;
  sessionId: string;
  tracks: PublishedTrack[];
  muted: boolean;
  joinedAt: number;
}

export type ServerMessage =
  | { type: "welcome"; participants: Participant[]; expiresAt: string }
  | { type: "joined"; participant: Participant }
  | { type: "updated"; participant: Participant }
  | { type: "left"; id: string }
  | { type: "pong" }
  /**
   * サーバーから退出させるときの正式な通知（code は CloseCode）。直後に同じ code で close するが、
   * close フレームはプロキシ次第で届かないので、クライアントは bye を信じる。
   */
  | { type: "bye"; code: number };

export type ClientMessage =
  | { type: "update"; tracks?: PublishedTrack[]; muted?: boolean }
  | { type: "ping" };

/** 退出理由（bye と close の code）。4000 番台はアプリ定義で、クライアントは再接続しない。 */
export const CloseCode = {
  RoomFull: 4003,
  RoomDeleted: 4004,
  Replaced: 4009,
  RoomExpired: 4010,
} as const;

export const TERMINAL_CLOSE_CODES: ReadonlySet<number> = new Set(Object.values(CloseCode));

const TRACK_KINDS: ReadonlySet<string> = new Set<TrackKind>(["mic", "screen", "screen-audio"]);

/** クライアントから来た JSON を検証する。不正なら null（黙って捨てる）。 */
export function parseClientMessage(raw: string): ClientMessage | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(m)) return null;
  const o = m;
  if (o.type === "ping") return { type: "ping" };
  if (o.type !== "update") return null;

  const out: { type: "update"; tracks?: PublishedTrack[]; muted?: boolean } = { type: "update" };
  if (o.muted !== undefined) {
    if (typeof o.muted !== "boolean") return null;
    out.muted = o.muted;
  }
  if (o.tracks !== undefined) {
    if (!Array.isArray(o.tracks) || o.tracks.length > 8) return null;
    const tracks: PublishedTrack[] = [];
    for (const t of o.tracks) {
      if (!isRecord(t)) return null;
      const { trackName, kind } = t;
      if (typeof trackName !== "string" || trackName.length === 0 || trackName.length > 64) return null;
      if (typeof kind !== "string" || !TRACK_KINDS.has(kind)) return null;
      tracks.push({ trackName, kind: kind as TrackKind });
    }
    out.tracks = tracks;
  }
  return out;
}

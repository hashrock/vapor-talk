/** 1ルームの参加上限（MVP の目標値）。 */
export const MAX_PARTICIPANTS_LIMIT = 20;
export const DEFAULT_EXPIRES_IN_SEC = 24 * 60 * 60;
export const MIN_EXPIRES_IN_SEC = 5 * 60;
export const MAX_EXPIRES_IN_SEC = 7 * 24 * 60 * 60;
export const ROOM_NAME_MAX = 80;
export const DISPLAY_NAME_MAX = 40;

export interface Room {
  id: string;
  name: string;
  maxParticipants: number;
  guestAccess: boolean;
  externalId: string | null;
  /** Web でログインユーザーが作ったルームの持ち主。API で作ったルームは null */
  ownerId: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface CreateRoomInput {
  name: string;
  expiresInSec: number;
  maxParticipants: number;
  guestAccess: boolean;
  externalId: string | null;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function intInRange(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

/** POST /api/v1/rooms（と Web のルーム作成）の入力を検証し、既定値を埋める。 */
export function parseCreateRoomInput(body: unknown): Parsed<CreateRoomInput> {
  const b = isRecord(body) ? body : {};

  let name = "";
  if (b.name !== undefined) {
    if (typeof b.name !== "string") return { ok: false, error: "name must be a string" };
    name = b.name.trim();
    if (name.length > ROOM_NAME_MAX) return { ok: false, error: `name must be at most ${ROOM_NAME_MAX} characters` };
  }

  let expiresInSec = DEFAULT_EXPIRES_IN_SEC;
  if (b.expiresIn !== undefined) {
    if (!intInRange(b.expiresIn, MIN_EXPIRES_IN_SEC, MAX_EXPIRES_IN_SEC)) {
      return { ok: false, error: `expiresIn must be an integer between ${MIN_EXPIRES_IN_SEC} and ${MAX_EXPIRES_IN_SEC} (seconds)` };
    }
    expiresInSec = b.expiresIn;
  }

  let maxParticipants = MAX_PARTICIPANTS_LIMIT;
  if (b.maxParticipants !== undefined) {
    if (!intInRange(b.maxParticipants, 2, MAX_PARTICIPANTS_LIMIT)) {
      return { ok: false, error: `maxParticipants must be an integer between 2 and ${MAX_PARTICIPANTS_LIMIT}` };
    }
    maxParticipants = b.maxParticipants;
  }

  let guestAccess = true;
  if (b.guestAccess !== undefined) {
    if (typeof b.guestAccess !== "boolean") return { ok: false, error: "guestAccess must be a boolean" };
    guestAccess = b.guestAccess;
  }

  let externalId: string | null = null;
  if (b.externalId !== undefined && b.externalId !== null) {
    if (typeof b.externalId !== "string" || b.externalId.length > 200) {
      return { ok: false, error: "externalId must be a string of at most 200 characters" };
    }
    externalId = b.externalId;
  }

  return { ok: true, value: { name: name || "ボイスチャット", expiresInSec, maxParticipants, guestAccess, externalId } };
}

export interface CreateTokenInput {
  name: string | null;
  expiresInSec: number;
}

/** POST /api/v1/rooms/:id/tokens の入力。トークンの有効期限はルームの期限を超えない。 */
export function parseCreateTokenInput(body: unknown, room: Room, now: Date): Parsed<CreateTokenInput> {
  const b = isRecord(body) ? body : {};
  let name: string | null = null;
  if (b.name !== undefined && b.name !== null) {
    const n = typeof b.name === "string" ? normalizeDisplayName(b.name) : null;
    if (!n) return { ok: false, error: `name must be a non-empty string of at most ${DISPLAY_NAME_MAX} characters` };
    name = n;
  }
  const remaining = Math.floor((Date.parse(room.expiresAt) - now.getTime()) / 1000);
  let expiresInSec = remaining;
  if (b.expiresIn !== undefined) {
    if (!intInRange(b.expiresIn, 60, MAX_EXPIRES_IN_SEC)) {
      return { ok: false, error: `expiresIn must be an integer between 60 and ${MAX_EXPIRES_IN_SEC} (seconds)` };
    }
    expiresInSec = Math.min(b.expiresIn, remaining);
  }
  return { ok: true, value: { name, expiresInSec } };
}

/** 表示名を正規化する。空・長すぎる名前は null。 */
export function normalizeDisplayName(raw: string): string | null {
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!name || [...name].length > DISPLAY_NAME_MAX) return null;
  return name;
}

export function isExpired(room: Pick<Room, "expiresAt">, now: Date): boolean {
  return Date.parse(room.expiresAt) <= now.getTime();
}

/** URL に載せるルーム ID（推測されにくい 16 文字）。 */
export function newRoomId(): string {
  return randomString(16);
}

/** ルーム作成者に一度だけ渡す管理キー。 */
export function newManageKey(): string {
  return "mk_" + randomString(32);
}

const ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789";

function randomString(len: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

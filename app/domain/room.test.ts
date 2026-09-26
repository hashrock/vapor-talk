import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPIRES_IN_SEC,
  MAX_PARTICIPANTS_LIMIT,
  isExpired,
  normalizeDisplayName,
  parseCreateRoomInput,
  parseCreateTokenInput,
  type Room,
} from "./room";

describe("parseCreateRoomInput", () => {
  it("空の入力には既定値を入れる", () => {
    const r = parseCreateRoomInput({});
    expect(r).toEqual({
      ok: true,
      value: { name: "ボイスチャット", expiresInSec: DEFAULT_EXPIRES_IN_SEC, maxParticipants: MAX_PARTICIPANTS_LIMIT, guestAccess: true, externalId: null },
    });
  });

  it("参加上限は 20 人まで", () => {
    expect(parseCreateRoomInput({ maxParticipants: 21 }).ok).toBe(false);
    expect(parseCreateRoomInput({ maxParticipants: 20 }).ok).toBe(true);
  });

  it("有効期限は 5 分〜7 日の整数秒", () => {
    expect(parseCreateRoomInput({ expiresIn: 60 }).ok).toBe(false);
    expect(parseCreateRoomInput({ expiresIn: 3600.5 }).ok).toBe(false);
    expect(parseCreateRoomInput({ expiresIn: 8 * 24 * 3600 }).ok).toBe(false);
    expect(parseCreateRoomInput({ expiresIn: 3600 }).ok).toBe(true);
  });

  it("型の違う値は拒否する", () => {
    expect(parseCreateRoomInput({ name: 1 }).ok).toBe(false);
    expect(parseCreateRoomInput({ guestAccess: "yes" }).ok).toBe(false);
  });
});

describe("parseCreateTokenInput", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const room: Room = {
    id: "r",
    name: "r",
    maxParticipants: 20,
    guestAccess: false,
    externalId: null,
    createdAt: now.toISOString(),
    expiresAt: "2026-01-01T01:00:00Z",
  };

  it("トークンの期限はルームの期限を超えない", () => {
    const r = parseCreateTokenInput({ expiresIn: 7200 }, room, now);
    expect(r.ok && r.value.expiresInSec).toBe(3600);
  });

  it("名前は正規化される", () => {
    const r = parseCreateTokenInput({ name: "  Alice\n" }, room, now);
    expect(r.ok && r.value.name).toBe("Alice");
  });
});

describe("normalizeDisplayName", () => {
  it("空白だけ・長すぎる名前は null", () => {
    expect(normalizeDisplayName("   ")).toBeNull();
    expect(normalizeDisplayName("あ".repeat(41))).toBeNull();
    expect(normalizeDisplayName("あ".repeat(40))).toBe("あ".repeat(40));
  });
});

describe("isExpired", () => {
  it("期限ちょうどで期限切れ", () => {
    expect(isExpired({ expiresAt: "2026-01-01T00:00:00Z" }, new Date("2026-01-01T00:00:00Z"))).toBe(true);
    expect(isExpired({ expiresAt: "2026-01-01T00:00:01Z" }, new Date("2026-01-01T00:00:00Z"))).toBe(false);
  });
});

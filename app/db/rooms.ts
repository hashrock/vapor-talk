import type { Room } from "../domain/room";

interface RoomRow {
  id: string;
  name: string;
  max_participants: number;
  guest_access: number;
  manage_key_hash: string;
  external_id: string | null;
  owner_id: string | null;
  created_at: string;
  expires_at: string;
}

function toRoom(r: RoomRow): Room {
  return {
    id: r.id,
    name: r.name,
    maxParticipants: r.max_participants,
    guestAccess: r.guest_access === 1,
    externalId: r.external_id,
    ownerId: r.owner_id,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

export async function insertRoom(db: D1Database, room: Room, manageKeyHash: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO rooms (id, name, max_participants, guest_access, manage_key_hash, external_id, owner_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      room.id,
      room.name,
      room.maxParticipants,
      room.guestAccess ? 1 : 0,
      manageKeyHash,
      room.externalId,
      room.ownerId,
      room.createdAt,
      room.expiresAt,
    )
    .run();
}

export type StoredRoom = Room & { manageKeyHash: string };

export async function findRoom(db: D1Database, id: string): Promise<StoredRoom | null> {
  const row = await db.prepare("SELECT * FROM rooms WHERE id = ?").bind(id).first<RoomRow>();
  return row ? { ...toRoom(row), manageKeyHash: row.manage_key_hash } : null;
}

/** ユーザーが作った、まだ期限の切れていないルーム（新しい順）。 */
export async function listOwnedRooms(db: D1Database, ownerId: string, now: Date): Promise<Room[]> {
  const { results } = await db
    .prepare("SELECT * FROM rooms WHERE owner_id = ? AND expires_at > ? ORDER BY created_at DESC")
    .bind(ownerId, now.toISOString())
    .all<RoomRow>();
  return results.map(toRoom);
}

export async function deleteRoomRow(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM rooms WHERE id = ?").bind(id).run();
}

/** 期限切れのルームを消して、その ID を返す。 */
export async function deleteExpiredRooms(db: D1Database, now: Date): Promise<string[]> {
  const { results } = await db
    .prepare("DELETE FROM rooms WHERE expires_at <= ? RETURNING id")
    .bind(now.toISOString())
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

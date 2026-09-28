import type { SessionUser } from "../user";

/** Google のプロフィールで users を作るか更新し、そのユーザーを返す。 */
export async function upsertUser(db: D1Database, profile: Omit<SessionUser, "id">): Promise<SessionUser> {
  const row = await db
    .prepare(
      `INSERT INTO users (id, email, name, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (email) DO UPDATE SET name = excluded.name, avatar_url = excluded.avatar_url
       RETURNING id`,
    )
    .bind(crypto.randomUUID(), profile.email, profile.name, profile.avatarUrl, new Date().toISOString())
    .first<{ id: string }>();
  return { id: row!.id, ...profile };
}

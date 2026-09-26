import app from "./app";
import { deleteExpiredRooms } from "./db/rooms";
import type { Bindings } from "./global";

export { RoomDO } from "./room-do";

export default {
  fetch: app.fetch,
  // 期限切れルームの行を消す（在室者は RoomDO の alarm が期限時刻に切断済み）
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      deleteExpiredRooms(env.DB, new Date()).then((ids) => {
        if (ids.length) console.log(`deleted ${ids.length} expired rooms`);
      }),
    );
  },
} satisfies ExportedHandler<Bindings>;

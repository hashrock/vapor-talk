import { defineConfig } from "vitest/config";

// vite.config.ts の @cloudflare/vite-plugin は Vitest と併用できないので分ける
export default defineConfig({
  test: {
    include: ["app/**/*.test.ts"],
    environment: "node",
  },
});

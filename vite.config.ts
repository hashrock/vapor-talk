import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import ssrPlugin from "vite-ssr-components/plugin";
import { inertiaPages } from "@hono/inertia/vite";

export default defineConfig({
  // Hono アプリは app/app.ts（app/server.ts は Worker エントリで DO も export する）
  plugins: [inertiaPages({ serverModule: "./app" }), tailwindcss(), cloudflare(), ssrPlugin()],
});

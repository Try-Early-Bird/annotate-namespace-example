import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * The panel is served by the sandbox's front door at /view, so it is built
 * for that base. `npm run dev` serves it on its own with hot reload and
 * proxies everything else to a sandbox running on :8081.
 */
const sandbox = process.env.SANDBOX_URL ?? "http://localhost:8081";

export default defineConfig({
  base: "/view/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": resolve(import.meta.dirname, "src") } },
  server: {
    proxy: {
      "/sandbox": sandbox,
      "/__annokit": sandbox,
      "/screen-rect": sandbox,
      "/vnc": sandbox,
      "/websockify": { target: sandbox, ws: true },
    },
  },
});

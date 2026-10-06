import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const base = process.env.VITE_BASE_PATH || "/";

export default defineConfig({
  base,
  plugins: [react()],
  // The browser-call SDK (retell-client-js-sdk + livekit-client, ~145 KB gzip) is a lazy chunk loaded only for
  // "Talk in browser", so its size does not affect the call page's first load.
  build: { chunkSizeWarningLimit: 600 },
});

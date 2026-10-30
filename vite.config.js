import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: /api -> FastAPI. In Docker, nginx.conf does the same proxying.
export default defineConfig({
  preview: { proxy: { "^/api/": "http://127.0.0.1:8000" } },
  plugins: [react()],
  server: { proxy: { "^/api/": "http://127.0.0.1:8000" } },
});

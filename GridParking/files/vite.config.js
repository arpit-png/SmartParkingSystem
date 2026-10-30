import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: /api -> FastAPI. In Docker, nginx.conf does the same proxying.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:8000" } },
});

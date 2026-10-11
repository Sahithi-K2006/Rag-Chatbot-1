import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const backend = process.env.VITE_API_PROXY ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { "/api": backend } },
  preview: { proxy: { "/api": backend } },
  // The only chunk above the default 500 kB is the lazily loaded hero shader (three.js + R3F, ~290 kB gzip).
  // It loads after the page is idle, only on the welcome screen, and never with reduced motion or no WebGL.
  build: { chunkSizeWarningLimit: 1200 },
});

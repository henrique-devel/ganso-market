import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiProxy = {
  target: "http://127.0.0.1:3000",
  changeOrigin: false,
  rewrite: (path: string): string => path.replace(/^\/api/, ""),
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api/health/live": apiProxy,
      "/api/health/ready": apiProxy,
      "/api/auth/login": apiProxy,
      "/api/auth/refresh": apiProxy,
      "/api/auth/logout": apiProxy,
      "/api/auth/session": apiProxy,
      "/api/polymarket/resolution-risk": apiProxy,
      "/api/polymarket/graph": apiProxy,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});

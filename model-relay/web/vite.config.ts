import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// 打包产物直接输出到后端包内的 static 目录，由 FastAPI 托管（requirements 10.5）
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "../src/model_relay/static"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // 开发态把 API 代理到本地 FastAPI
      "/admin": "http://localhost:8080",
      "/v1": "http://localhost:8080",
      "/health": "http://localhost:8080",
    },
  },
});

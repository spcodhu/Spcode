import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// base 相对路径：PWA 会被桌面 harness 内嵌服务托管在任意端口/路径下（lan.ts 静态目录）
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  build: {
    target: "es2022",
  },
});

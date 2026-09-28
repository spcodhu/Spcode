import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          // 第二个入口：pi 引擎宿主，跑在 Electron utilityProcess 中。
          "agent-host": resolve(__dirname, "src/agent-host/index.ts"),
        },
        output: {
          // utilityProcess.fork 加载 ESM 要求 .mjs 扩展名
          entryFileNames: (chunk) => (chunk.name === "agent-host" ? "agent-host.mjs" : "[name].js"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react(), tailwindcss()],
  },
});

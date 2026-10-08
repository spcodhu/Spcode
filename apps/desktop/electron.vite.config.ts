import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

// @spcode/shared 是导出 TS 源码的 workspace 包，必须内联编译进产物——
// 若 externalize，打包后它以真实目录落在 app.asar/node_modules 下，
// Node 类型剥离拒绝加载 node_modules 里的 .ts（ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING），
// 主进程启动即崩。dev/测试走 pnpm symlink（真实路径不在 node_modules）所以只有安装包会炸。
const inlineWorkspace = externalizeDepsPlugin({ exclude: ["@spcode/shared"] });

export default defineConfig({
  main: {
    plugins: [inlineWorkspace],
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
    plugins: [inlineWorkspace],
  },
  renderer: {
    plugins: [react(), tailwindcss()],
  },
});

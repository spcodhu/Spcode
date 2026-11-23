import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { languageBuildPlugin } from "../../packages/shared/src/i18n/build";

const root = dirname(fileURLToPath(import.meta.url));

/** 唯一 UI 源码仍在 desktop/renderer；本包负责产出浏览器与 Electron 共用的独立构建。 */
export default defineConfig({
  root: resolve(root, "../desktop/src/renderer"),
  plugins: [languageBuildPlugin(), react(), tailwindcss()],
  build: {
    outDir: resolve(root, "dist"),
    emptyOutDir: true,
    sourcemap: true,
  },
});

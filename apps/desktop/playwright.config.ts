import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // 精简后的用例按「同一用户旅程合并多段场景」，一条用例可能冷启动 3–5 次 Electron；
  // 60s 会在合规机器上误杀，单条上限放宽到 180s（通过用时不变）。
  timeout: 180000,
  retries: 0,
  workers: 1, // Electron 实例串行，避免窗口打架
  reporter: [["list"]],
});

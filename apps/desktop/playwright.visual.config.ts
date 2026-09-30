import { defineConfig } from "@playwright/test";

/** 视觉截图脚本（非回归测试）：pnpm test:visual */
export default defineConfig({
  testDir: "./scripts/visual",
  timeout: 120000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
});

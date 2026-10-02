import { defineConfig } from "vitest/config";

// 协议层与集成测试都跑在 node 环境（Node 24 自带全局 WebSocket / WebCrypto）；
// 集成测试直接装配 apps/desktop 的真实 RemoteServer（同 remote-lan.test.ts 的做法）。
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});

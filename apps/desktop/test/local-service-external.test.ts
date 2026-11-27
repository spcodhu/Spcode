import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalService } from "../src/main/local-service.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LocalService 外部控制面", () => {
  it("使用 HTTPS 外部 Router，不启动本地服务并保留引导 token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ protocolVersion: 1 }), { status: 200 })),
    );
    const service = new LocalService({
      appPath: "/tmp/app",
      resourcesPath: "/tmp/resources",
      isPackaged: false,
      enabled: true,
      externalControlPlaneUrl: "https://agent.example.com",
      externalBootstrapToken: "oidc-token",
      invoke: async () => ({}),
    });
    expect(await service.start()).toBe(true);
    const url = service.workbenchUrl("superagent")!;
    expect(url).toContain("https://agent.example.com/");
    expect(url).toContain("view=superagent");
    expect(url).toContain("bootstrap=oidc-token");
  });

  it("拒绝公网明文 HTTP 外部 Router", async () => {
    const service = new LocalService({
      appPath: "/tmp/app",
      resourcesPath: "/tmp/resources",
      isPackaged: false,
      enabled: true,
      externalControlPlaneUrl: "http://agent.example.com",
      invoke: async () => ({}),
    });
    expect(await service.start()).toBe(false);
  });
});

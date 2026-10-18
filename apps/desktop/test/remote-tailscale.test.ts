/**
 * Tailscale 通道测试（M3，注入假 runner，不依赖本机 tailscale）：
 * - 检测：CLI 不存在 / tailscaled 未运行 / 非 Running 态 → 不可用；
 *   Running + MagicDNS → 可用且解析 dnsName（去尾部点）；
 * - enable：执行 `tailscale serve --bg --https=443 http://localhost:<port>`，URL 推导正确；
 *   命令失败返回 null（不抛错）；
 * - disable：仅在开启过时执行 `tailscale serve --https=443 off`；
 * - RemoteServer 集成：开启后 URL 进 urls() 与 status()，设置关闭后撤销映射。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type HostCommand, type HostEvent, type ScheduleTask } from "@spcode/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RemoteServer } from "../src/main/remote/index.js";
import { PairingManager } from "../src/main/remote/pairing.js";
import { PushService } from "../src/main/remote/push.js";
import {
  parseTailscaleStatus,
  TailscaleManager,
  type TailscaleRunResult,
} from "../src/main/remote/transport/tailscale.js";
import type { RemoteTransport } from "../src/main/remote/transport/types.js";
import type { RegistryLike } from "../src/main/session-helpers.js";
import type { SessionRegistryEntry } from "../src/main/session-registry.js";

const RUNNING_STATUS = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "my-mac.tail1234.ts.net." },
});

/** 假 runner：按参数表应答，记录全部调用 */
function makeRunner(table: Record<string, TailscaleRunResult>) {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    const key = args.join(" ");
    return table[key] ?? { code: 1, stdout: "", stderr: `未预期命令：${key}` };
  };
  return { calls, run };
}

describe("parseTailscaleStatus", () => {
  it("Running + MagicDNS（带尾部点）→ 可用且去点", () => {
    expect(parseTailscaleStatus(RUNNING_STATUS)).toEqual({ available: true, dnsName: "my-mac.tail1234.ts.net" });
  });

  it("非 Running / 缺 DNSName / 非法 JSON → 不可用", () => {
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: "Stopped" }))).toEqual({
      available: false,
      dnsName: null,
    });
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: "Running", Self: {} }))).toEqual({
      available: false,
      dnsName: null,
    });
    expect(parseTailscaleStatus("not json")).toEqual({ available: false, dnsName: null });
  });
});

describe("TailscaleManager 检测分支", () => {
  it("tailscale 未安装（spawn 失败 / 非零退出）→ 不可用", async () => {
    const { run } = makeRunner({ "status --json": { code: -1, stdout: "", stderr: "ENOENT" } });
    const ts = new TailscaleManager({ run });
    expect(await ts.detect()).toEqual({ available: false, dnsName: null });
    expect(ts.status()).toEqual({ available: false, enabled: false, url: null });
  });

  it("检测结果 15s 缓存：第二次 detect 不再 spawn", async () => {
    const { calls, run } = makeRunner({ "status --json": { code: 0, stdout: RUNNING_STATUS, stderr: "" } });
    const ts = new TailscaleManager({ run });
    await ts.detect();
    await ts.detect();
    expect(calls.filter((c) => c[0] === "status").length).toBe(1);
    expect((await ts.detect(true)).available).toBe(true); // force 重测
    expect(calls.filter((c) => c[0] === "status").length).toBe(2);
  });
});

describe("TailscaleManager enable / disable", () => {
  it("开启：执行 serve --bg --https=443，URL 为 https://<magicdns>", async () => {
    const { calls, run } = makeRunner({
      "status --json": { code: 0, stdout: RUNNING_STATUS, stderr: "" },
      "serve --bg --https=443 http://localhost:8123": { code: 0, stdout: "", stderr: "" },
    });
    const ts = new TailscaleManager({ run });
    const url = await ts.enable(8123);
    expect(url).toBe("https://my-mac.tail1234.ts.net");
    expect(calls.some((c) => c.join(" ") === "serve --bg --https=443 http://localhost:8123")).toBe(true);
    expect(ts.status()).toEqual({ available: true, enabled: true, url });

    // 关闭：执行 off，状态复位
    await ts.disable();
    expect(calls.some((c) => c.join(" ") === "serve --https=443 off")).toBe(true);
    expect(ts.status().enabled).toBe(false);
    expect(ts.status().url).toBeNull();

    // 未开启时 disable 是空操作
    calls.length = 0;
    await ts.disable();
    expect(calls.length).toBe(0);
  });

  it("tailscale 不可用时 enable 返回 null 且不执行 serve", async () => {
    const { calls, run } = makeRunner({ "status --json": { code: -1, stdout: "", stderr: "" } });
    const ts = new TailscaleManager({ run });
    expect(await ts.enable(8123)).toBeNull();
    expect(calls.some((c) => c[0] === "serve")).toBe(false);
  });

  it("serve 命令失败返回 null（不抛错）", async () => {
    const { run } = makeRunner({
      "status --json": { code: 0, stdout: RUNNING_STATUS, stderr: "" },
      "serve --bg --https=443 http://localhost:8123": { code: 1, stdout: "", stderr: "access denied" },
    });
    const ts = new TailscaleManager({ run });
    expect(await ts.enable(8123)).toBeNull();
    expect(ts.status().enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RemoteServer 集成：tailscale 开关 → serve 映射 → urls()/status() 透出
// ---------------------------------------------------------------------------

describe("RemoteServer 集成 tailscale", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "spcode-remote-ts-"));
  });
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  /** 固定端口 stub transport：runner 应答表可精确匹配 serve 命令 */
  function makeServer(tailscaleEnabled: boolean) {
    const pairing = new PairingManager({ baseDir: dir });
    const stubTransport: RemoteTransport = {
      start: async () => {},
      stop: async () => {},
      onConnection: () => {},
      getAdvertisedUrls: () => ["http://192.168.1.5:8123"],
      getPort: () => 8123,
    };
    const registryEntries = new Map<string, SessionRegistryEntry>();
    const registry: RegistryLike = {
      list: () => [...registryEntries.values()],
      get: (id) => registryEntries.get(id),
      upsert: (entry) => void registryEntries.set(entry.id, entry),
      patch: () => {},
      remove: (id) => void registryEntries.delete(id),
    };
    const bridge = {
      onEvent: (_cb: (e: HostEvent) => void) => () => {},
      async call(_cmd: HostCommand & { id: string }) {
        return { ok: true };
      },
      replyPermission: () => {},
      replyQuestion: () => {},
    };
    const scheduler = {
      list: (): ScheduleTask[] => [],
      create: () => {
        throw new Error("not used");
      },
      update: () => null,
      remove: () => {},
      runNow: async () => "x",
    };
    const settings = {
      get: () => ({
        ...DEFAULT_SETTINGS,
        remote: { enabled: true, port: 0, relayUrl: null, tailscale: tailscaleEnabled, pushEnabled: false },
      }),
    };
    const { calls, run } = makeRunner({
      "status --json": { code: 0, stdout: RUNNING_STATUS, stderr: "" },
      "serve --bg --https=443 http://localhost:8123": { code: 0, stdout: "", stderr: "" },
      "serve --https=443 off": { code: 0, stdout: "", stderr: "" },
    });
    const tailscale = new TailscaleManager({ run });
    const server = new RemoteServer({
      settings,
      bridge,
      scheduler,
      registry,
      pairing,
      transport: stubTransport,
      push: new PushService({ baseDir: dir }),
      tailscale,
    });
    return { server, calls, tailscale };
  }

  it("开启：serve 映射 LAN 端口，URL 进 urls() 与 status()；停止时执行 off", async () => {
    const { server, calls } = makeServer(true);
    await server.start();
    expect(calls.some((c) => c.join(" ") === "serve --bg --https=443 http://localhost:8123")).toBe(true);
    expect(server.urls()).toContain("https://my-mac.tail1234.ts.net");
    expect(server.status().tailscale).toEqual({
      available: true,
      enabled: true,
      url: "https://my-mac.tail1234.ts.net",
    });
    await server.stop();
    expect(calls.some((c) => c.join(" ") === "serve --https=443 off")).toBe(true);
  });

  it("关闭开关：不执行 serve，urls() 不含 tailscale 项，status() enabled=false", async () => {
    const { server, calls } = makeServer(false);
    await server.start();
    expect(calls.some((c) => c[0] === "serve")).toBe(false);
    expect(server.urls().every((u) => !u.startsWith("https://"))).toBe(true);
    expect(server.status().tailscale.enabled).toBe(false);
    await server.stop();
  });
});

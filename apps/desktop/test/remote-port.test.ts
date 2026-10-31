import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppSettings, DEFAULT_SETTINGS, type HostCommand } from "@spcode/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteServer } from "../src/main/remote/index.js";
import { PairingManager } from "../src/main/remote/pairing.js";
import { PushService } from "../src/main/remote/push.js";
import { TailscaleManager } from "../src/main/remote/transport/tailscale.js";
import type { PeerConnection, RemoteTransport } from "../src/main/remote/transport/types.js";

class FakeTransport implements RemoteTransport {
  starts = 0;
  stops = 0;
  async start() {
    this.starts++;
  }
  async stop() {
    this.stops++;
  }
  onConnection(_cb: (peer: PeerConnection) => void) {}
  getAdvertisedUrls() {
    return ["http://192.168.1.5:43123"];
  }
  getPort() {
    return 43123;
  }
}

describe("远程监听端口持久化", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("首次绑定后回写实际端口，applySettings 不重启，后续启动复用", async () => {
    dir = mkdtempSync(join(tmpdir(), "spcode-remote-port-"));
    let remote: AppSettings["remote"] = { ...DEFAULT_SETTINGS.remote, enabled: true, port: null };
    const transport = new FakeTransport();
    const onLanPortBound = vi.fn((port: number) => {
      remote = { ...remote, port };
    });
    const server = new RemoteServer({
      settings: { get: () => ({ ...DEFAULT_SETTINGS, remote }) },
      bridge: {
        onEvent: () => () => {},
        call: async (_cmd: HostCommand & { id: string }) => ({ ok: true }),
        replyPermission: () => {},
        replyQuestion: () => {},
      },
      scheduler: {
        list: () => [],
        create: () => {
          throw new Error("not used");
        },
        update: () => null,
        remove: () => {},
        runNow: async () => "unused",
      },
      registry: {
        list: () => [],
        get: () => undefined,
        upsert: () => {},
        patch: () => {},
        remove: () => {},
      },
      pairing: new PairingManager({ baseDir: dir }),
      transport,
      onLanPortBound,
      push: new PushService({ baseDir: dir }),
      tailscale: new TailscaleManager({ run: async () => ({ code: 0, stdout: "", stderr: "" }) }),
    });

    await server.start();
    expect(onLanPortBound).toHaveBeenCalledWith(43123);
    expect(remote.port).toBe(43123);
    expect(server.status().port).toBe(43123);
    expect(transport.starts).toBe(1);

    await server.applySettings();
    expect(transport.starts).toBe(1);
    expect(transport.stops).toBe(0);

    await server.stop();
    await server.start();
    expect(remote.port).toBe(43123);
    expect(onLanPortBound).toHaveBeenCalledTimes(1);
    expect(transport.starts).toBe(2);
    await server.stop();
  });
});

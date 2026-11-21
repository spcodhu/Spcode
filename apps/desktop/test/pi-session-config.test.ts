import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createSpcodeResourceLoader, createSpcodeSettingsManager } from "../src/agent-host/pi-session-config.js";

const directories: string[] = [];

function fixtureDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "spcode-pi-contract-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("managed Pi session configuration", () => {
  it("disables warming without changing explicit compaction settings", () => {
    const settings = createSpcodeSettingsManager({
      cacheWarming: "idle",
      compaction: { enabled: true, reserveTokens: 12345, keepRecentTokens: 23456 },
    });
    expect(settings.getCacheWarmingMode()).toBe("off");
    expect(settings.getCompactionSettings()).toMatchObject({ reserveTokens: 12345, keepRecentTokens: 23456 });
  });

  it("does not activate native dispatchers even when explicitly configured", async () => {
    const cwd = fixtureDirectory();
    const invoked: string[] = [];
    const settingsManager = createSpcodeSettingsManager({
      extensions: ["builtin:mcp", "builtin:codemode", "builtin:tool-search"],
    });
    const loader = createSpcodeResourceLoader({
      cwd,
      agentDir: join(cwd, "agent"),
      settingsManager,
      noContextFiles: true,
      extensionFactories: [
        ...["mcp", "codemode", "tool-search"].map((name) => ({
          name,
          builtin: true,
          factory: () => {
            invoked.push(name);
          },
        })),
        {
          name: "spcode-test",
          factory: (pi) => {
            invoked.push("spcode-test");
            pi.registerTool({
              name: "host_tool",
              label: "host tool",
              description: "host-owned test tool",
              parameters: Type.Object({}),
              execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
            });
          },
        },
      ],
    });
    await loader.reload();
    expect(invoked).toEqual(["spcode-test"]);
    expect(loader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()])).toEqual([
      "host_tool",
    ]);
  });

  it("reads the prior v3 transcript without rewriting its original evidence", () => {
    const cwd = fixtureDirectory();
    const file = join(cwd, "legacy.jsonl");
    const timestamp = "2026-11-19T00:00:00.000Z";
    const entries = [
      { type: "session", version: 3, id: "550e8400-e29b-41d4-a716-446655440000", timestamp, cwd },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp,
        message: { role: "user", content: "legacy request", timestamp: 1 },
      },
      {
        type: "custom",
        id: "custom-1",
        parentId: "user-1",
        timestamp,
        customType: "spcode-test",
        data: { preserved: true },
      },
    ];
    writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    const manager = SessionManager.open(file);
    expect(manager.getHeader()?.version).toBe(3);
    expect(manager.getEntry("custom-1")).toMatchObject({ data: { preserved: true } });
    expect(manager.getBranch().map((entry) => entry.id)).toEqual(["user-1", "custom-1"]);
    expect(manager.buildSessionProjection().messages.some((message) => message.role === "user")).toBe(true);
  });

  it("creates an offline model runtime with the managed version", async () => {
    const cwd = fixtureDirectory();
    const runtime = await ModelRuntime.create({
      authPath: join(cwd, "auth.json"),
      modelsPath: join(cwd, "models.json"),
      allowModelNetwork: false,
    });
    expect(runtime.getModel("openrouter", "openai/gpt-4o")).toBeDefined();
  });
});

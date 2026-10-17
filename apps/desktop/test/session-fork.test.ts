import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostCommand } from "@spcode/shared";
import {
  backfillSessionFile,
  buildForkRegistryEntry,
  prepareForkCommand,
  type RegistryLike,
} from "../src/main/session-helpers.js";
import type { SessionRegistryEntry } from "../src/main/session-registry.js";
import { teardownHostEvents, useStore } from "../src/renderer/src/store.js";

/**
 * Fork 会话：主进程侧的注册表补全/条目构造（纯函数）+ 渲染层 forkSession 的状态落位。
 * 宿主侧的 forkFrom 文件复制由 pi 引擎自身保证，这里只钉我们包装层的契约。
 */

function makeRegistry(entries: SessionRegistryEntry[]): RegistryLike {
  let list = [...entries];
  return {
    list: () => list,
    get: (id) => list.find((e) => e.id === id),
    upsert: (entry) => {
      list = [entry, ...list.filter((e) => e.id !== entry.id)];
    },
    patch: (id, p) => {
      list = list.map((e) => (e.id === id ? { ...e, ...p, id, updatedAt: e.updatedAt } : e));
    },
    remove: (id) => {
      list = list.filter((e) => e.id !== id);
    },
  };
}

const source: SessionRegistryEntry = {
  id: "src-1",
  mode: "project",
  cwd: "/tmp/proj",
  title: "重构支付模块",
  model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
  thinkingLevel: "high",
  sessionFile: "/home/u/.spcode/agent/sessions/-tmp-proj/2026_src-1.jsonl",
  planMode: true,
  planFile: "/home/u/.spcode/plans/src-1.md",
  createdAt: 1,
  updatedAt: 2,
};

describe("prepareForkCommand 注册表补全", () => {
  it("补全 sessionFile/cwd/mode，缺省继承 model/thinkingLevel/planMode", () => {
    const r = prepareForkCommand(makeRegistry([source]), { sourceSessionId: "src-1", newSessionId: "new-1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.sourceSessionFile).toBe(source.sessionFile);
    expect(r.payload.cwd).toBe("/tmp/proj");
    expect(r.payload.mode).toBe("project");
    expect(r.payload.model).toEqual(source.model);
    expect(r.payload.thinkingLevel).toBe("high");
    expect(r.payload.planMode).toBe(true);
  });

  it("显式指定的 model/thinkingLevel/planMode 覆盖继承（含显式 planMode=false）", () => {
    const r = prepareForkCommand(makeRegistry([source]), {
      sourceSessionId: "src-1",
      newSessionId: "new-1",
      model: { provider: "openai", modelId: "gpt-5" },
      thinkingLevel: "low",
      planMode: false,
    });
    expect(r.ok && r.payload.model).toEqual({ provider: "openai", modelId: "gpt-5" });
    expect(r.ok && r.payload.thinkingLevel).toBe("low");
    expect(r.ok && r.payload.planMode).toBe(false);
  });

  it("源会话不存在时报错", () => {
    const r = prepareForkCommand(makeRegistry([]), { sourceSessionId: "ghost", newSessionId: "new-1" });
    expect(r.ok).toBe(false);
  });
});

describe("buildForkRegistryEntry 新条目构造", () => {
  it("默认标题「<源标题> · 分叉」，继承 mode/cwd，不复制 planFile", () => {
    const e = buildForkRegistryEntry(source, { sourceSessionId: "src-1", newSessionId: "new-1" }, 100);
    expect(e.title).toBe("重构支付模块 · 分叉");
    expect(e.mode).toBe("project");
    expect(e.cwd).toBe("/tmp/proj");
    expect(e.model).toEqual(source.model);
    expect(e.planMode).toBe(true);
    expect(e.planFile).toBeNull();
    expect(e.sessionFile).toBeNull();
    expect(e.forkedFrom).toBe("src-1");
    expect(e.createdAt).toBe(100);
  });

  it("显式标题优先（trim 归一化）", () => {
    const e = buildForkRegistryEntry(source, {
      sourceSessionId: "src-1",
      newSessionId: "new-1",
      title: "  实验分支  ",
    });
    expect(e.title).toBe("实验分支");
  });
});

describe("backfillSessionFile: session.fork", () => {
  it("fork 响应回填 sessionFile 到新条目", () => {
    const reg = makeRegistry([]);
    reg.upsert(buildForkRegistryEntry(source, { sourceSessionId: "src-1", newSessionId: "new-1" }));
    const cmd: HostCommand = {
      id: "c1",
      type: "session.fork",
      payload: { sourceSessionId: "src-1", newSessionId: "new-1" },
    };
    backfillSessionFile(
      cmd,
      {
        sessionId: "new-1",
        sessionFile: "/home/u/.spcode/agent/sessions/-tmp-proj/2026_new-1.jsonl",
        model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
        thinkingLevel: "high",
      },
      reg,
    );
    expect(reg.get("new-1")?.sessionFile).toContain("new-1.jsonl");
  });
});

// ---------------------------------------------------------------------------
// pi forkFrom 集成：钉住 sessionDir 必须显式传源目录这个坑（不带 agentDir 时
// forkFrom 内部 getDefaultSessionDir 会落到 pi 默认目录 ~/.pi/agent/sessions/）
// ---------------------------------------------------------------------------

describe("SessionManager.forkFrom 集成（真实文件）", () => {
  const tmpDirs: string[] = [];
  const makeTmp = () => {
    const d = mkdtempSync(join(tmpdir(), "spcode-fork-it-"));
    tmpDirs.push(d);
    return d;
  };
  afterEach(() => {
    while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  it("fork 文件落在源会话同目录、带 parentSession 头、完整复制消息", () => {
    const home = makeTmp();
    const sessionsDir = join(home, "agent", "sessions", "-tmp-proj");
    const sm = SessionManager.create("/tmp/proj", sessionsDir);
    sm.appendMessage({ role: "user", content: "帮我重构支付模块", timestamp: Date.now() });
    // pi 的 _persist 在首条 assistant 消息出现前不落盘（hasAssistant 守卫）
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "好的，先看现状。" }],
      timestamp: Date.now(),
    } as never);
    const srcFile = sm.getSessionFile();
    expect(srcFile).toBeTruthy();
    expect(existsSync(srcFile!)).toBe(true);

    // 与宿主 fork case 同款的调用方式
    const forked = SessionManager.forkFrom(srcFile!, "/tmp/proj", dirname(srcFile!), {
      id: "fork-it-1",
      parentSession: srcFile!,
    });
    const forkFile = forked.getSessionFile();
    expect(forkFile).toContain(sessionsDir);
    expect(forkFile).not.toBe(srcFile);

    const lines = readFileSync(forkFile!, "utf-8").trim().split("\n");
    const header = JSON.parse(lines[0]!) as { type: string; id: string; parentSession?: string };
    expect(header.type).toBe("session");
    expect(header.id).toBe("fork-it-1");
    expect(header.parentSession).toBe(srcFile);
    // 消息完整复制
    expect(lines.length).toBe(3); // header + user + assistant
    expect(readFileSync(forkFile!, "utf-8")).toContain("帮我重构支付模块");
    expect(readFileSync(forkFile!, "utf-8")).toContain("好的，先看现状。");
  });
});

// ---------------------------------------------------------------------------
// 渲染层 forkSession
// ---------------------------------------------------------------------------

function stubSpcodeApi(commandImpl?: (cmd: never) => Promise<unknown>) {
  const command = vi.fn(commandImpl ?? (async () => []));
  vi.stubGlobal("window", {
    spcode: {
      onEvent: vi.fn(() => () => {}),
      onUpdateState: vi.fn(() => () => {}),
      updateGetState: vi.fn(async () => ({ status: "idle" })),
      getSettings: vi.fn(async () => ({})),
      listSessions: vi.fn(async () => []),
      command,
    },
  });
  return { command };
}

afterEach(() => {
  teardownHostEvents();
  vi.unstubAllGlobals();
});

describe("forkSession（渲染层）", () => {
  it("成功后注册新会话、写入 forkedFrom 并激活", async () => {
    const { command } = stubSpcodeApi(async (cmd: { type: string; payload?: { newSessionId?: string } }) => {
      if (cmd.type === "session.fork") {
        return {
          sessionId: cmd.payload?.newSessionId,
          sessionFile: "/tmp/forked.jsonl",
          model: { provider: "p", modelId: "m" },
          thinkingLevel: "medium",
          supportedThinkingLevels: [],
          planMode: true,
        };
      }
      return [];
    });
    useStore.setState((s) => ({
      registrySessions: [
        {
          id: "src",
          mode: "chat" as const,
          cwd: "",
          title: "调研报告",
          model: { provider: "p", modelId: "m" },
          thinkingLevel: "medium",
          sessionFile: "/tmp/src.jsonl",
          createdAt: 1,
          updatedAt: 1,
        },
        ...s.registrySessions,
      ],
      activeSessionId: null,
    }));

    const newId = await useStore.getState().forkSession("src", { planMode: true });

    const s = useStore.getState();
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session.fork",
        payload: expect.objectContaining({ sourceSessionId: "src", newSessionId: newId, planMode: true }),
      }),
    );
    expect(s.activeSessionId).toBe(newId);
    expect(s.sessions[newId]?.meta.title).toBe("调研报告 · 分叉");
    expect(s.sessions[newId]?.planMode).toBe(true);
    expect(s.sessions[newId]?.sessionFile).toBe("/tmp/forked.jsonl");
    const regEntry = s.registrySessions.find((r) => r.id === newId);
    expect(regEntry?.forkedFrom).toBe("src");
    expect(regEntry?.title).toBe("调研报告 · 分叉");
  });

  it("源会话不存在时直接抛错，不发命令", async () => {
    const { command } = stubSpcodeApi();
    useStore.setState({ registrySessions: [] });
    await expect(useStore.getState().forkSession("ghost", {})).rejects.toThrow("源会话不存在");
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: "session.fork" }));
  });
});

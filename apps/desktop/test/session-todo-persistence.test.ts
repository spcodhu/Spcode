import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRegistryEntry } from "@spcode/shared";
import { afterEach, describe, expect, it } from "vitest";
import { recordSessionTodos } from "../src/main/session-helpers.js";
import { SessionRegistry } from "../src/main/session-registry.js";

const dirs: string[] = [];

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "spcode-todo-persist-"));
  dirs.push(dir);
  return dir;
}

function entry(id = "s-todo"): SessionRegistryEntry {
  return {
    id,
    mode: "project",
    cwd: "/tmp/project",
    title: "任务进度",
    model: null,
    thinkingLevel: "medium",
    sessionFile: `/tmp/${id}.jsonl`,
    createdAt: 1,
    updatedAt: 1,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Todo 清单持久化", () => {
  it("TodoWrite 全量清单写入注册表并跨实例恢复", () => {
    const home = makeHome();
    const registry = new SessionRegistry(home);
    registry.upsert(entry());
    const todos = [
      { content: "完成沙盒热更新", status: "completed" as const },
      { content: "恢复 Todo 进度", activeForm: "正在恢复 Todo 进度", status: "in_progress" as const },
      { content: "补测试", status: "pending" as const },
    ];

    recordSessionTodos(registry, "s-todo", todos);

    const disk = JSON.parse(readFileSync(join(home, "sessions.json"), "utf-8")) as SessionRegistryEntry[];
    expect(disk[0]?.todos).toEqual(todos);
    expect(new SessionRegistry(home).get("s-todo")?.todos).toEqual(todos);
  });

  it("空清单会清除持久化进度；不存在的会话不会被意外创建", () => {
    const home = makeHome();
    const registry = new SessionRegistry(home);
    registry.upsert({ ...entry(), todos: [{ content: "旧任务", status: "completed" }] });

    recordSessionTodos(registry, "s-todo", []);
    expect(registry.get("s-todo")?.todos).toEqual([]);

    recordSessionTodos(registry, "ghost", [{ content: "不该出现", status: "pending" }]);
    expect(registry.get("ghost")).toBeUndefined();
    expect(registry.list()).toHaveLength(1);
  });

  it("存量坏 Todo 数据逐项清洗，不影响会话加载", () => {
    const home = makeHome();
    writeFileSync(
      join(home, "sessions.json"),
      JSON.stringify([
        {
          ...entry("legacy"),
          todos: [
            { content: "合法任务", activeForm: "正在做", status: "pending" },
            { content: "  ", status: "pending" },
            { content: "坏状态", status: "done" },
            null,
            { content: "合法完成", activeForm: 42, status: "completed" },
          ],
        },
        { ...entry("bad-shape"), todos: "not-an-array" },
      ]),
    );

    const registry = new SessionRegistry(home);
    expect(registry.get("legacy")?.todos).toEqual([
      { content: "合法任务", activeForm: "正在做", status: "pending" },
      { content: "合法完成", status: "completed" },
    ]);
    expect(registry.get("bad-shape")?.todos).toEqual([]);
  });
});

import type { RemoteSessionSnapshot } from "@spcode/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../src/state/store.js";

const session: RemoteSessionSnapshot = {
  id: "s-todo-snapshot",
  mode: "chat",
  cwd: "",
  title: "任务",
  model: null,
  thinkingLevel: "medium",
  sessionFile: "/tmp/s.jsonl",
  createdAt: 1,
  updatedAt: 1,
  status: "idle",
};

beforeEach(() => {
  useAppStore.getState().reset();
});

describe("手机快照恢复 Todo", () => {
  it("认证快照带入持久化清单，空清单清除旧进度", () => {
    const todos = [
      { content: "已完成", status: "completed" as const },
      { content: "进行中", activeForm: "正在处理", status: "in_progress" as const },
    ];
    useAppStore.getState().applySessionSnapshot([{ ...session, todos }], [], []);
    expect(useAppStore.getState().todos[session.id]).toEqual(todos);

    useAppStore.getState().applySessionSnapshot([{ ...session, todos: [] }], [], []);
    expect(useAppStore.getState().todos[session.id]).toBeUndefined();
  });

  it("旧桌面快照不带 todos 时保留本端实时数据", () => {
    const todos = [{ content: "实时任务", status: "pending" as const }];
    useAppStore.getState().setTodos(session.id, todos);
    useAppStore.getState().applySessionSnapshot([session], [], []);
    expect(useAppStore.getState().todos[session.id]).toEqual(todos);
  });
});

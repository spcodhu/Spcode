/** @vitest-environment jsdom */
import type { RemoteToolCall } from "@spcode/shared";
import { i18n, setLocale } from "@spcode/shared/i18n";
import { RunActivityTimeline, type RunSegment } from "@spcode/ui";
import { act, type ComponentProps, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type TimelineProps = ComponentProps<typeof RunActivityTimeline>;

let root: Root;
let mount: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("zh-CN");
  mount = document.createElement("div");
  document.body.append(mount);
  root = createRoot(mount);
});

afterEach(async () => {
  await act(async () => root.unmount());
  mount.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setLocale("zh-CN");
});

async function renderTimeline(props: TimelineProps) {
  await act(async () =>
    root.render(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(RunActivityTimeline, {
          renderText: (block) => createElement("span", { "data-text-id": block.key }, block.text),
          ...props,
        }),
      ),
    ),
  );
}

function elements(id: string, scope: ParentNode = mount): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`));
}

function element(id: string, scope: ParentNode = mount): HTMLElement {
  const found = elements(id, scope);
  expect(found).toHaveLength(1);
  return found[0]!;
}

function toggle(scope: ParentNode): HTMLButtonElement {
  return scope.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
}

async function click(button: HTMLElement) {
  await act(async () => button.click());
}

function call(id: string, name: string, overrides: Partial<RemoteToolCall> = {}): RemoteToolCall {
  return { id, name, args: { path: `${id}.ts` }, status: "done", output: `output:${id}`, ...overrides };
}

function tools(id: string, calls: RemoteToolCall[]): RunSegment {
  return { kind: "tools", id, calls };
}

function text(id: string, value = id): RunSegment {
  return { kind: "text", id, text: value };
}

describe("共享运行时间线 DOM", () => {
  it("思考、同名工具组和阶段正文按到达顺序平级排列，没有重复活动层", async () => {
    const segments: RunSegment[] = [
      { kind: "thinking", id: "thinking", text: "检查实现", done: true },
      tools("read-a", [call("a", "read")]),
      tools("read-b", [call("b", "read")]),
      text("stage", "阶段结果"),
      tools("mixed", [call("c", "read"), call("test", "bash", { args: { command: "pnpm test" } })]),
      text("answer", "最终答复"),
    ];
    await renderTimeline({ segments, active: true, progressSegment: segments.at(-1) });

    const process = element("run-process");
    expect(process.dataset.state).toBe("expanded");
    const header = element("run-process-header");
    expect(header.tagName).toBe("BUTTON");
    expect(header.textContent).toMatch(/\D4\D/);
    expect(header.className).not.toContain("border");
    expect(header.firstElementChild).toBe(element("run-process-icon", header));
    const title = element("run-progress", header).querySelector("span");
    expect(title?.className).toContain("text-[13px]");
    expect(title?.className).toContain("font-normal");
    const body = element("run-process-body", process);
    const list = body.matches("ol") ? body : body.querySelector("ol")!;
    const items = elements("run-timeline-item", body);
    expect(items.map((item) => item.dataset.kind)).toEqual(["thinking", "tools", "text", "tools", "tools", "text"]);
    for (const item of items) {
      expect(item.tagName).toBe("LI");
      expect(item.parentElement).toBe(list);
      expect(item.className).toContain("pl-10");
      expect(item.className).toContain("after:w-3");
    }
    expect(elements("run-activity")).toHaveLength(0);
    expect(elements("run-activity-header")).toHaveLength(0);
    expect(elements("run-tool-step").map((step) => [step.dataset.tool, step.dataset.count])).toEqual([
      ["read", "2"],
      ["read", "1"],
      ["bash", "1"],
    ]);
    expect(elements("run-stage-output").map((output) => output.textContent)).toEqual(["阶段结果", "最终答复"]);
    expect(element("run-progress").closest('[data-testid="run-process-header"]')).toBe(element("run-process-header"));
    expect(element("run-progress").dataset.kind).toBe("output");
    for (const row of [element("run-thinking"), ...elements("run-tool-step")]) {
      expect(toggle(row).getAttribute("aria-expanded")).toBe("false");
    }
  });

  it("同名组一层展开全部调用的输入输出，失败计数及每个文件预览保留", async () => {
    const onOpenFile = vi.fn();
    const segments = [
      tools("reads", [
        call("a", "read", { args: { path: "src/a.ts", offset: 12 } }),
        call("b", "read", { args: { path: "src/b.ts" }, status: "error", output: "permission denied" }),
      ]),
      text("answer"),
    ];
    await renderTimeline({ segments, active: false, onOpenFile });
    const header = element("run-process-header");
    expect(header.textContent).toMatch(/\D2\D/);
    expect(element("run-failed-count", header).textContent).toContain("1 次失败");
    expect(header.textContent).not.toContain("其中");
    expect(element("run-process").dataset.state).toBe("expanded");
    expect(element("run-process-icon", header).classList.contains("text-danger")).toBe(false);

    const step = element("run-tool-step");
    expect(step.dataset.status).toBe("error");
    expect(step.dataset.count).toBe("2");
    expect(element("run-failed-count", step).textContent).toContain("1 次失败");
    expect(toggle(step).getAttribute("aria-expanded")).toBe("false");
    await click(toggle(step));
    expect(toggle(step).getAttribute("aria-expanded")).toBe("true");
    const detail = element("run-step-detail", step);
    expect(detail.closest('[aria-hidden="true"]')).toBeNull();
    expect(detail.querySelector("button[aria-expanded]")).toBeNull();
    const calls = elements("run-tool-call", detail);
    expect(calls.map((item) => [item.dataset.callId, item.dataset.status])).toEqual([
      ["a", "done"],
      ["b", "error"],
    ]);
    expect(calls[0]!.textContent).toContain('"offset": 12');
    expect(calls[0]!.textContent).toContain("output:a");
    expect(calls[1]!.textContent).toContain("src/b.ts");
    expect(calls[1]!.textContent).toContain("permission denied");
    for (const item of calls) await click(element("run-tool-preview", item));
    expect(onOpenFile.mock.calls).toEqual([["src/a.ts"], ["src/b.ts"]]);
    expect(toggle(step).getAttribute("aria-expanded")).toBe("true");
  });

  it("单次文件调用可从头部预览，展开直接显示 diff 和响应", async () => {
    const onOpenFile = vi.fn();
    const segments = [
      tools("edit", [
        call("edit", "edit", {
          args: { path: "src/edit.ts", oldText: "before", newText: "after" },
          patch: "--- a/src/edit.ts\n+++ b/src/edit.ts\n@@ -1 +1 @@\n-before\n+after",
          output: "updated file",
        }),
      ]),
    ];
    await renderTimeline({ segments, active: true, onOpenFile });
    const step = element("run-tool-step");
    const preview = element("run-tool-preview", step);
    expect(preview.closest('[data-testid="run-step-detail"]')).toBeNull();
    await click(preview);
    expect(onOpenFile).toHaveBeenCalledExactlyOnceWith("src/edit.ts");
    expect(toggle(step).getAttribute("aria-expanded")).toBe("false");
    await click(toggle(step));
    const detail = element("run-step-detail", step);
    expect(detail.closest('[aria-hidden="true"]')).toBeNull();
    expect(detail.textContent).toContain("-before");
    expect(detail.textContent).toContain("+after");
    expect(detail.textContent).toContain("updated file");
    expect(element("run-tool-call", detail).dataset.callId).toBe("edit");
  });

  it("运行中混合失败与未完成调用保留失败 badge，收起后仍显示当前工具参数", async () => {
    const segment = tools("commands", [
      call("bad", "bash", { args: { command: "first command" }, status: "error" }),
      call("live", "bash", { args: { command: "pnpm test --run" }, status: "running", output: "" }),
    ]);
    await renderTimeline({ segments: [segment], active: true, progressSegment: segment });
    const step = element("run-tool-step");
    expect(step.dataset.status).toBe("running");
    expect(step.dataset.count).toBe("2");
    expect(element("run-failed-count", step).textContent).toContain("1 次失败");
    expect(element("run-failed-count", element("run-process-header")).textContent).toContain("1 次失败");
    await click(element("run-process-header"));
    expect(element("run-process").dataset.state).toBe("collapsed");
    const progress = element("run-progress");
    expect(progress.dataset.kind).toBe("tool");
    expect(progress.dataset.tool).toBe("bash");
    expect(progress.textContent).toContain("pnpm test --run");
    expect(progress.closest('[aria-hidden="true"]')).toBeNull();
  });

  it.each([true, false])("完成时保留用户的过程展开状态 %s 和工具详情，不重建已有节点", async (open) => {
    const running = tools("read", [call("read", "read", { status: "running" })]);
    await renderTimeline({ segments: [running], active: true, progressSegment: running });
    const process = element("run-process");
    const step = element("run-tool-step");
    await click(toggle(step));
    const detail = element("run-step-detail");
    if (!open) await click(element("run-process-header"));
    const finished = tools("read", [call("read", "read")]);
    const answer = text("answer", "执行完毕");
    await renderTimeline({ segments: [finished, answer], active: true, progressSegment: answer });
    await renderTimeline({ segments: [finished, answer], active: false });

    expect(element("run-process")).toBe(process);
    expect(process.dataset.state).toBe(open ? "expanded" : "collapsed");
    expect(element("run-process-header").getAttribute("aria-expanded")).toBe(String(open));
    expect(element("run-tool-step")).toBe(step);
    expect(element("run-step-detail")).toBe(detail);
    expect(toggle(step).getAttribute("aria-expanded")).toBe("true");
    expect(step.dataset.status).toBe("done");
    expect(elements("run-progress")).toHaveLength(0);
    const summary = element("run-summary");
    expect(summary.textContent).toBe("执行完毕");
    expect(process.contains(summary)).toBe(false);
    expect(process.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(elements("run-stage-output")).toHaveLength(0);
    if (!open) await click(element("run-process-header"));
    expect(detail.closest('[aria-hidden="true"]')).toBeNull();
  });

  it("历史默认展开；追加同名调用和切换 active 不重置已展开的历史详情", async () => {
    const history = tools("old", [call("a", "read")]);
    await renderTimeline({ segments: [history, text("stage")], active: false });
    expect(element("run-process").dataset.state).toBe("expanded");
    const step = element("run-tool-step");
    await click(toggle(step));
    const item = element("run-timeline-item");
    const detail = element("run-step-detail");

    const grouped = tools("old", [call("a", "read"), call("b", "read", { status: "running" })]);
    await renderTimeline({ segments: [grouped, text("stage")], active: true, progressSegment: grouped });
    expect(elements("run-timeline-item")[0]).toBe(item);
    expect(element("run-tool-step")).toBe(step);
    expect(step.dataset.count).toBe("2");
    expect(toggle(step).getAttribute("aria-expanded")).toBe("true");
    expect(element("run-step-detail")).toBe(detail);
    expect(elements("run-tool-call", detail).map((entry) => entry.dataset.callId)).toEqual(["a", "b"]);
    await renderTimeline({
      segments: [tools("old", [call("a", "read"), call("b", "read")]), text("stage")],
      active: false,
    });
    expect(element("run-process").dataset.state).toBe("expanded");
    expect(element("run-tool-step")).toBe(step);
    expect(toggle(step).getAttribute("aria-expanded")).toBe("true");
  });

  it("流式思考默认收起，delta、工具到达和完成都不强制展开", async () => {
    const thinking: RunSegment = { kind: "thinking", id: "thinking", text: "先检查", done: false };
    await renderTimeline({ segments: [thinking], active: true, progressSegment: thinking });
    const row = element("run-thinking");
    const button = toggle(row);
    expect(button.getAttribute("aria-expanded")).toBe("false");

    const delta = { ...thinking, text: "先检查，再验证" };
    await renderTimeline({ segments: [delta], active: true, progressSegment: delta });
    expect(element("run-thinking")).toBe(row);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    const finished = { ...delta, done: true };
    const tool = tools("read", [call("a", "read")]);
    await renderTimeline({ segments: [finished, tool], active: true, progressSegment: tool });
    await renderTimeline({ segments: [finished, tool, text("answer")], active: false });
    expect(element("run-thinking")).toBe(row);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(row.textContent).toContain("先检查，再验证");
  });

  it("思考折叠摘要持续跟随最新尾部，长段落也不固定显示开头", async () => {
    const opening = "开场白不应一直固定显示。";
    const initial = `${opening}${"中间分析内容".repeat(40)}最近完成的第一步。`;
    const thinking: RunSegment = { kind: "thinking", id: "thinking-tail", text: initial, done: false };
    await renderTimeline({ segments: [thinking], active: true, progressSegment: thinking });
    const preview = element("run-thinking-preview");
    expect(preview.textContent).toContain("最近完成的第一步");
    expect(preview.textContent).not.toContain(opening);

    const latest = "最新一步正在检查生图结果";
    const updated = { ...thinking, text: `${initial}${latest}` };
    await renderTimeline({ segments: [updated], active: true, progressSegment: updated });
    expect(element("run-thinking-preview")).toBe(preview);
    expect(preview.textContent).toContain(latest);
    expect(preview.textContent).not.toContain(opening);
    expect(preview.textContent!.length).toBeLessThanOrEqual(160);
    expect(toggle(element("run-thinking")).getAttribute("aria-expanded")).toBe("false");
  });

  it("只有最终文本时只展示一次总结，没有空过程和工具", async () => {
    await renderTimeline({ segments: [text("answer", "直接答复")], active: false });
    expect(element("run-summary").textContent).toBe("直接答复");
    expect(mount.textContent).toBe("直接答复");
    expect(elements("run-process")).toHaveLength(0);
    expect(elements("run-tool-step")).toHaveLength(0);
    expect(elements("run-progress")).toHaveLength(0);
  });

  it("无最终正文时保留过程；无工具的阶段正文与思考不生成工具组", async () => {
    const segments: RunSegment[] = [
      text("stage", "检查说明"),
      { kind: "thinking", id: "thinking", text: "等待结果", done: true },
    ];
    await renderTimeline({ segments, active: false });
    expect(element("run-process").dataset.state).toBe("expanded");
    expect(elements("run-summary")).toHaveLength(0);
    expect(elements("run-timeline-item").map((item) => item.dataset.kind)).toEqual(["text", "thinking"]);
    expect(element("run-stage-output").textContent).toBe("检查说明");
    expect(elements("run-tool-step")).toHaveLength(0);
    expect(elements("run-failed-count")).toHaveLength(0);
  });

  it("空初始运行显示 idle，思考和文本进度跟随事件，结束后空内容不生成过程", async () => {
    await renderTimeline({ segments: [], active: true });
    expect(element("run-process").dataset.state).toBe("expanded");
    expect(element("run-progress").dataset.kind).toBe("idle");
    expect(elements("run-timeline-item")).toHaveLength(0);
    const thinking: RunSegment = { kind: "thinking", id: "thinking", text: "", done: false };
    await renderTimeline({ segments: [thinking], active: true, progressSegment: thinking });
    expect(element("run-progress").dataset.kind).toBe("thinking");
    const answer = text("answer");
    await renderTimeline({ segments: [answer], active: true, progressSegment: answer });
    expect(element("run-progress").dataset.kind).toBe("output");
    expect(element("run-progress").hasAttribute("data-tool")).toBe(false);
    await renderTimeline({
      segments: [text("blank", " \n"), { ...thinking, done: true }, tools("empty", [])],
      active: false,
    });
    expect(elements("run-process")).toHaveLength(0);
    expect(elements("run-summary")).toHaveLength(0);
    expect(elements("run-progress")).toHaveLength(0);
    expect(mount.textContent).toBe("");
  });

  it("完成后冻结耗时，宿主清除 startedAt 也不丢失本轮计时", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-11-20T00:00:00Z").getTime();
    vi.setSystemTime(startedAt);
    const segments = [tools("read", [call("a", "read")])];
    await renderTimeline({ segments, active: true, startedAt });
    await act(async () => vi.advanceTimersByTime(3000));
    expect(element("run-process-header").textContent).toContain("3s");
    await renderTimeline({ segments, active: false });
    const frozen = element("run-process-header").textContent;
    expect(frozen).toContain("3s");
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(element("run-process-header").textContent).toBe(frozen);
    expect(elements("run-progress")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

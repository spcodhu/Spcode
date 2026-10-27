/** @vitest-environment jsdom */
import type { QuestionRequest } from "@spcode/shared";
import { i18n, setLocale } from "@spcode/shared/i18n";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuestionCard as MobileQuestionCard } from "../../mobile/src/components/QuestionCard.js";
import { useAppStore } from "../../mobile/src/state/store.js";
import { QuestionInline } from "../src/renderer/src/components/QuestionCard.js";

const state = vi.hoisted(() => ({ request: null as QuestionRequest | null, reply: vi.fn() }));
vi.mock("../src/renderer/src/store", () => ({
  useStore: (select: (s: unknown) => unknown) =>
    select({ pendingQuestions: state.request ? [state.request] : [], replyQuestion: state.reply }),
}));
vi.mock("../../mobile/src/state/controller", () => ({ replyQuestion: state.reply }));

function planRequest(): QuestionRequest {
  return {
    requestId: "plan",
    sessionId: "s1",
    purpose: "plan-approval",
    questions: [
      {
        question: "The plan is ready. Start executing?",
        presentation: { question: { key: "questions:plan.title" } },
        options: [
          { value: "approve", label: "Start executing", presentation: { label: { key: "questions:plan.approve" } } },
          { value: "revise", label: "Keep refining", presentation: { label: { key: "questions:plan.revise" } } },
        ],
      },
    ],
  };
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.reply.mockReset();
  useAppStore.getState().reset();
  useAppStore.setState({ sessions: { s1: { title: "User title" } as any } });
  state.request = planRequest();
  setLocale("zh-CN");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  setLocale("zh-CN");
  vi.unstubAllGlobals();
});

for (const platform of ["desktop", "mobile"] as const) {
  describe(`${platform} question card`, () => {
    async function render() {
      await act(async () =>
        root.render(
          createElement(
            I18nextProvider,
            { i18n },
            platform === "desktop"
              ? createElement(QuestionInline, { sessionId: "s1" })
              : createElement(MobileQuestionCard, { request: state.request! }),
          ),
        ),
      );
    }
    function element<T extends HTMLElement = HTMLButtonElement>(id: string): T {
      const found = document.querySelector<T>(`[data-testid="${id}"]`);
      expect(found).not.toBeNull();
      return found!;
    }
    async function click(id: string) {
      await act(async () => element(id).click());
    }
    async function type(text: string) {
      const input = element<HTMLInputElement>(platform === "desktop" ? "question-free-text" : "question-free-text-0");
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }

    it("re-renders translations without losing stable selected values", async () => {
      await render();
      expect(element("question-option-0-0").textContent).toContain("开始执行");
      await click("question-option-0-0");
      await act(async () => setLocale("en"));
      expect(element("question-option-0-0").textContent).toContain("Start executing");
      expect(element("question-option-0-0").getAttribute("aria-pressed")).toBe("true");
      await click("question-submit");
      expect(state.reply).toHaveBeenLastCalledWith("plan", { "0": { kind: "options", values: ["approve"] } });
    });

    it("typed approval remains text even when an approval option was selected", async () => {
      await render();
      await click("question-option-0-0");
      await type("approve");
      await act(async () => setLocale("en"));
      const input = document.querySelector("input")!;
      expect(input.value).toBe("approve");
      await click("question-submit");
      expect(state.reply).toHaveBeenLastCalledWith("plan", { "0": { kind: "text", text: "approve" } });
    });

    it("handles duplicate/delimited labels and multi-select arrays without translating model text", async () => {
      state.request = {
        requestId: "multi",
        sessionId: "s1",
        questions: [
          {
            question: "模型提问",
            multiSelect: true,
            options: [
              { value: "option-0", label: "A, B、C" },
              { value: "option-1", label: "A, B、C" },
            ],
          },
        ],
      };
      await render();
      await click("question-option-0-0");
      await click("question-option-0-1");
      await act(async () => setLocale("en"));
      expect(document.body.textContent).toContain("模型提问");
      expect(element("question-option-0-0").textContent).toContain("A, B、C");
      await click("question-submit");
      expect(state.reply).toHaveBeenLastCalledWith("multi", {
        "0": { kind: "options", values: ["option-0", "option-1"] },
      });
      await type(" custom, answer ");
      await click("question-submit");
      expect(state.reply).toHaveBeenLastCalledWith("multi", { "0": { kind: "text", text: " custom, answer " } });
    });

    it("单选题自动进入下一题，返回保留答案且最后一题不自动提交", async () => {
      if (platform !== "desktop") return;
      state.request = {
        requestId: "paging-single",
        sessionId: "s1",
        questions: [
          { question: "第一题", options: [{ value: "a", label: "A" }] },
          { question: "第二题", options: [{ value: "b", label: "B" }] },
        ],
      };
      await render();
      await click("question-option-0-0");
      expect(element("question-option-1-0").getAttribute("aria-pressed")).toBe("false");
      expect(state.reply).not.toHaveBeenCalled();

      await click("question-previous");
      expect(element("question-option-0-0").getAttribute("aria-pressed")).toBe("true");
      await click("question-next");
      await click("question-option-1-0");
      expect(state.reply).not.toHaveBeenCalled();
      await click("question-submit");
      expect(state.reply).toHaveBeenLastCalledWith("paging-single", {
        "0": { kind: "options", values: ["a"] },
        "1": { kind: "options", values: ["b"] },
      });
    });

    it("多选与自由输入只保存答案，必须显式点击下一题", async () => {
      if (platform !== "desktop") return;
      state.request = {
        requestId: "paging-manual",
        sessionId: "s1",
        questions: [
          {
            question: "多选题",
            multiSelect: true,
            options: [
              { value: "a", label: "A" },
              { value: "b", label: "B" },
            ],
          },
          { question: "文本题" },
        ],
      };
      await render();
      await click("question-option-0-0");
      await click("question-option-0-1");
      expect(container.querySelector('[data-testid="question-option-1-0"]')).toBeNull();
      expect(state.reply).not.toHaveBeenCalled();

      await click("question-next");
      expect(container.textContent).toContain("文本题");
      await type("手动填写");
      expect(state.reply).not.toHaveBeenCalled();
      await click("question-submit");
      expect(state.reply).toHaveBeenLastCalledWith("paging-manual", {
        "0": { kind: "options", values: ["a", "b"] },
        "1": { kind: "text", text: "手动填写" },
      });
    });

    it("dismisses explicitly and resets state only when request identity changes", async () => {
      await render();
      await click("question-option-0-0");
      await click("question-dismiss");
      expect(state.reply).toHaveBeenLastCalledWith("plan", { "0": { kind: "dismiss" } });
      state.request = { ...planRequest(), requestId: "next" };
      await render();
      expect(element("question-option-0-0").getAttribute("aria-pressed")).toBe("false");
    });
  });
}

import {
  buildQuestionAnswers,
  dismissQuestionAnswers,
  formatQuestionAnswers,
  type QuestionRequest,
  validateQuestionAnswers,
} from "@spcode/shared";
import { describe, expect, it } from "vitest";
import { createAskUserQuestionTool } from "../src/agent-host/tools/ask-user.js";

const request: QuestionRequest = {
  requestId: "q1",
  sessionId: "s1",
  questions: [
    {
      question: "Same question",
      options: [
        { value: "option-0", label: "A, B" },
        { value: "option-1", label: "A, B" },
      ],
    },
    {
      question: "Same question",
      multiSelect: true,
      options: [
        { value: "option-0", label: "X、Y" },
        { value: "option-1", label: "Z" },
      ],
    },
  ],
};

describe("structured question answers", () => {
  it("keeps index keys and array selections, including duplicate/delimited labels", () => {
    const answers = buildQuestionAnswers(request, { "0": ["option-1"], "1": ["option-0", "option-1"] }, {});
    expect(answers).toEqual({
      "0": { kind: "options", values: ["option-1"] },
      "1": { kind: "options", values: ["option-0", "option-1"] },
    });
    expect(validateQuestionAnswers(request, answers)).toEqual(answers);
    expect(formatQuestionAnswers(request, answers)).toBe("Q: Same question\nA: A, B\n\nQ: Same question\nA: X、Y, Z");
  });

  it("free text overrides shortcuts without trimming or parsing its contents", () => {
    const answers = buildQuestionAnswers(
      request,
      { "0": ["option-0"], "1": ["option-1"] },
      { "0": " approve ", "1": "A、B, C" },
    );
    expect(answers).toEqual({ "0": { kind: "text", text: " approve " }, "1": { kind: "text", text: "A、B, C" } });
    expect(formatQuestionAnswers(request, answers)).toContain("A:  approve ");
    expect(buildQuestionAnswers(request, {}, {})).toEqual(dismissQuestionAnswers(request));
  });

  it.each([
    null,
    [],
    { "0": "A, B" },
    { "Same question": { kind: "text", text: "x" } },
    { "01": { kind: "dismiss" } },
    { "2": { kind: "dismiss" } },
    { "0": { kind: "options", values: [] } },
    { "0": { kind: "options", values: ["option-0", "option-1"] } },
    { "1": { kind: "options", values: ["option-0", "option-0"] } },
    { "0": { kind: "options", values: ["A, B"] } },
    { "0": { kind: "text", text: 1 } },
    { "0": { kind: "options", values: ["option-0"], text: "approve" } },
  ])("rejects malformed or label-based input %j", (input) => {
    expect(validateQuestionAnswers(request, input)).toBeNull();
  });

  it("allows empty dismissal and clones option arrays", () => {
    expect(validateQuestionAnswers(request, {})).toEqual({});
    const input = { "0": { kind: "options", values: ["option-0"] } };
    const parsed = validateQuestionAnswers(request, input)!;
    input["0"].values.push("option-1");
    expect(parsed["0"]).toEqual({ kind: "options", values: ["option-0"] });
  });
});

describe("AskUserQuestion", () => {
  it("assigns option indices, preserves model labels, and formats using the original request", async () => {
    let actual!: QuestionRequest;
    const tool = createAskUserQuestionTool("s1", async (r) => {
      actual = r;
      return { "0": { kind: "options", values: ["option-1"] }, "1": { kind: "text", text: "approve" } };
    });
    const result = await tool.execute(
      "t1",
      {
        questions: [
          { question: "Same question", options: [{ label: "中文, label" }, { label: "中文, label" }] },
          { question: "Same question" },
        ],
      },
      undefined as never,
    );
    expect(actual.questions[0]!.options).toEqual([
      { value: "option-0", label: "中文, label" },
      { value: "option-1", label: "中文, label" },
    ]);
    expect(actual.questions[0]!.presentation).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toBe(
      "Q: Same question\nA: 中文, label\n\nQ: Same question\nA: approve",
    );
    expect(JSON.stringify(tool.parameters)).not.toContain("presentation");
  });

  it("returns fixed English dismissal with a presentation descriptor", async () => {
    const tool = createAskUserQuestionTool("s1", async () => ({ "0": { kind: "dismiss" } }));
    const result = await tool.execute("t", { questions: [{ question: "Test" }] }, undefined as never);
    expect(result.content).toEqual([{ type: "text", text: "User dismissed the question without answering." }]);
    expect(result.details).toMatchObject({ presentation: { key: "questions:ask.dismissed" } });
  });
});

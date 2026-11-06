/**
 * AskUserQuestion —— 结构化提问工具：选项卡片经主进程转到渲染进程，
 * 用户在 UI 上点选/输入后答案沿 question.reply 回到这里。
 */
import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  formatQuestionAnswers,
  type QuestionAnswers,
  type QuestionRequest,
  validateQuestionAnswers,
} from "@spcode/shared";
import { type Static, Type } from "typebox";
import { STRICT_PREFER_TOOL_SAMPLING } from "./tool-schema.js";

const questionSchema = Type.Object({
  questions: Type.Array(
    Type.Object({
      question: Type.String({ description: "Concise question text", minLength: 1 }),
      header: Type.Optional(Type.String({ description: "Short chip label", minLength: 1 })),
      multiSelect: Type.Optional(Type.Boolean({ description: "Whether multiple options may be picked" })),
      options: Type.Optional(
        Type.Array(
          Type.Object({
            label: Type.String({ description: "Option label", minLength: 1 }),
            description: Type.Optional(Type.String({ description: "Optional explanation" })),
          }),
          { description: "2-4 options; users can always type a custom answer", minItems: 2, maxItems: 4 },
        ),
      ),
    }),
    { minItems: 1, maxItems: 4 },
  ),
});

type Params = Static<typeof questionSchema>;

function validateInput(args: Params): string | null {
  if (!Array.isArray(args.questions) || args.questions.length < 1 || args.questions.length > 4) {
    return "questions must contain 1-4 items";
  }
  for (const question of args.questions) {
    if (!question.question.trim()) return "question text must not be blank";
    if (question.header !== undefined && !question.header.trim()) return "question header must not be blank";
    if (question.options !== undefined && (question.options.length < 2 || question.options.length > 4)) {
      return "options must contain 2-4 items when provided";
    }
    if (question.options?.some((option) => !option.label.trim())) return "option labels must not be blank";
  }
  return null;
}

export type QuestionAnswerer = (request: QuestionRequest) => Promise<QuestionAnswers>;

export function createAskUserQuestionTool(sessionId: string, ask: QuestionAnswerer): ToolDefinition {
  return {
    name: "AskUserQuestion",
    label: "Ask User Question",
    description:
      "Ask the user concise multiple-choice questions — only when genuinely stuck after investigation, not as a first response to friction. The UI always provides a free-text answer field, so options are shortcuts, not limits.",
    promptSnippet: "Ask the user structured multiple-choice questions when blocked",
    parameters: questionSchema,
    constrainedSampling: STRICT_PREFER_TOOL_SAMPLING,
    execute: async (_id, args: Params) => {
      const invalid = validateInput(args);
      if (invalid) {
        return {
          content: [{ type: "text", text: `Invalid AskUserQuestion input: ${invalid}` }],
          details: undefined,
          isError: true,
        };
      }
      const request: QuestionRequest = {
        requestId: randomUUID(),
        sessionId,
        questions: args.questions.map((q) => ({
          question: q.question,
          header: q.header,
          multiSelect: q.multiSelect,
          options: q.options?.map((o, i) => ({ value: `option-${i}`, label: o.label, description: o.description })),
        })),
      };
      const answers = validateQuestionAnswers(request, await ask(request)) ?? {};
      const text = formatQuestionAnswers(request, answers);
      return {
        content: [{ type: "text", text: text || "User dismissed the question without answering." }],
        details: {
          answers,
          ...(!text ? { presentation: { key: "questions:ask.dismissed" } } : {}),
        },
      };
    },
  };
}

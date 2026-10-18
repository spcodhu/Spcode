/**
 * AskUserQuestion —— 结构化提问工具：选项卡片经主进程转到渲染进程，
 * 用户在 UI 上点选/输入后答案沿 question.reply 回到这里。
 */
import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { QuestionRequest } from "@spcode/shared";
import { type Static, Type } from "typebox";

const questionSchema = Type.Object({
  questions: Type.Array(
    Type.Object({
      question: Type.String({ description: "Concise question text" }),
      header: Type.Optional(Type.String({ description: "Short chip label" })),
      multiSelect: Type.Optional(Type.Boolean({ description: "Whether multiple options may be picked" })),
      options: Type.Optional(
        Type.Array(
          Type.Object({
            label: Type.String({ description: "Option label" }),
            description: Type.Optional(Type.String({ description: "Optional explanation" })),
          }),
          { description: "2-4 options; users can always type a custom answer" },
        ),
      ),
    }),
  ),
});

type Params = Static<typeof questionSchema>;

export type QuestionAnswerer = (request: QuestionRequest) => Promise<Record<string, string>>;

export function createAskUserQuestionTool(sessionId: string, ask: QuestionAnswerer): ToolDefinition {
  return {
    name: "AskUserQuestion",
    label: "Ask User Question",
    description:
      "Ask the user concise multiple-choice questions — only when genuinely stuck after investigation, not as a first response to friction. The UI always provides a free-text answer field, so options are shortcuts, not limits.",
    promptSnippet: "Ask the user structured multiple-choice questions when blocked",
    parameters: questionSchema,
    execute: async (_id, args: Params) => {
      const answers = await ask({
        requestId: randomUUID(),
        sessionId,
        questions: args.questions.map((q) => ({
          question: q.question,
          header: q.header,
          multiSelect: q.multiSelect,
          options: q.options?.map((o) => ({ label: o.label, description: o.description })),
        })),
      });
      // 协议键 = 题号索引（三端统一）；按索引还原题目文本渲染 Q/A（兼容旧客户端的文本键）
      const text = Object.entries(answers)
        .map(([k, a]) => {
          const q = /^\d+$/.test(k) ? (args.questions[Number(k)]?.question ?? k) : k;
          return `Q: ${q}\nA: ${a}`;
        })
        .join("\n\n");
      return {
        content: [{ type: "text", text: text || "User dismissed the question without answering." }],
        details: { answers },
      };
    },
  };
}

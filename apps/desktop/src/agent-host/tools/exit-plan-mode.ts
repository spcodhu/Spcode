/** ExitPlanMode is the sole approval gate for leaving plan mode. Labels are presentation only. */
import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { formatQuestionAnswer, type QuestionRequest, validateQuestionAnswers } from "@spcode/shared";
import { Type } from "typebox";
import type { QuestionAnswerer } from "./ask-user.js";

export const EXIT_PLAN_QUESTION = "The plan is ready. Start executing?";
export const EXIT_PLAN_APPROVE_LABEL = "Start executing";
export const EXIT_PLAN_APPROVE_VALUE = "approve";

const exitPlanSchema = Type.Object({});

export function createExitPlanModeTool(opts: {
  sessionId: string;
  ask: QuestionAnswerer;
  isPlanMode: () => boolean;
  onApproved: () => Promise<void>;
}): ToolDefinition {
  return {
    name: "ExitPlanMode",
    label: "Exit Plan Mode",
    description:
      "Call when the plan is complete and saved via WritePlan, or when the user asks to start executing. Shows the user an approval card; on approval, plan mode is disabled and full tools are restored so you can start executing immediately. Do NOT call this before the plan is ready.",
    promptSnippet: "Request user approval to exit plan mode and start executing",
    parameters: exitPlanSchema,
    execute: async () => {
      if (!opts.isPlanMode()) {
        return {
          content: [{ type: "text", text: "Plan mode is not active. This tool is not needed." }],
          details: { approved: false, presentation: { key: "questions:plan.notActive" } },
          isError: true,
        };
      }
      const request: QuestionRequest = {
        requestId: randomUUID(),
        sessionId: opts.sessionId,
        purpose: "plan-approval",
        questions: [
          {
            question: EXIT_PLAN_QUESTION,
            header: "Plan approval",
            presentation: {
              question: { key: "questions:plan.title" },
              header: { key: "questions:plan.header" },
            },
            options: [
              {
                value: EXIT_PLAN_APPROVE_VALUE,
                label: EXIT_PLAN_APPROVE_LABEL,
                description: "Exit plan mode and start implementing the plan",
                presentation: {
                  label: { key: "questions:plan.approve" },
                  description: { key: "questions:plan.approveDescription" },
                },
              },
              {
                value: "revise",
                label: "Keep refining",
                description: "Stay in plan mode and continue refining the plan",
                presentation: {
                  label: { key: "questions:plan.revise" },
                  description: { key: "questions:plan.reviseDescription" },
                },
              },
            ],
          },
        ],
      };
      const answers = validateQuestionAnswers(request, await opts.ask(request));
      const answer = answers?.["0"];
      // Only an explicit valid option selection for this pending request may authorize execution.
      // Never accept legacy label/text keys, free text (even "approve"), or an already-ended plan.
      if (
        answer?.kind === "options" &&
        answer.values.length === 1 &&
        answer.values[0] === EXIT_PLAN_APPROVE_VALUE &&
        opts.isPlanMode()
      ) {
        await opts.onApproved();
        return {
          content: [
            {
              type: "text",
              text: [
                "The user approved the plan. Plan mode is disabled and all tools are restored.",
                "Start executing now: first call TodoWrite to split the plan into a task list (one item per step, with activeForm).",
                "After each milestone, immediately update TodoWrite status; do not batch updates at the end.",
              ].join("\n"),
            },
          ],
          details: { approved: true, presentation: { key: "questions:plan.approved" } },
        };
      }
      const feedback = formatQuestionAnswer(request.questions[0]!, answer);
      if (feedback) {
        return {
          content: [
            {
              type: "text",
              text: `The user has not approved the plan. Remain in plan mode. User reply: "${feedback}". Refine the plan accordingly, call WritePlan again to update and display the plan, then call ExitPlanMode again.`,
            },
          ],
          details: { approved: false, presentation: { key: "questions:plan.feedback", params: { answer: feedback } } },
        };
      }
      return {
        content: [
          {
            type: "text",
            text: "The user dismissed the confirmation. Remain in plan mode and wait for further instructions. If the user asks to execute, call ExitPlanMode again.",
          },
        ],
        details: { approved: false, presentation: { key: "questions:plan.dismissed" } },
      };
    },
  };
}

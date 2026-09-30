/**
 * ExitPlanMode —— 计划模式的唯一退出通道(CLI plan 模式同款设计)。
 *
 * 模型在计划就绪、或用户表达执行意愿时调用:经 askQuestion 通道弹批准卡,
 * 用户点「开始执行」后 onApproved 关闭计划态、恢复全量工具,工具返回执行约束
 * (先建 TodoWrite 清单),模型同一轮直接开始执行;其余回答一律视为继续调整。
 * 用专用工具而不是裸 AskUserQuestion:harness 必须确定性捕获"批准"这一时刻。
 */
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { QuestionAnswerer } from "./ask-user.js";

/** 批准卡的问题文案(同时是 answers 的 key,改动要同步解析处) */
export const EXIT_PLAN_QUESTION = "计划已就绪,是否开始执行?";
export const EXIT_PLAN_APPROVE_LABEL = "开始执行";

const exitPlanSchema = Type.Object({});

export function createExitPlanModeTool(opts: {
  sessionId: string;
  ask: QuestionAnswerer;
  /** 当前是否在计划态(正常态下误调用时兜底) */
  isPlanMode: () => boolean;
  /** 用户点了「开始执行」:关闭计划态、恢复工具、注入关闭消息 */
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
          content: [{ type: "text", text: "当前不在计划模式,无需调用此工具。" }],
          details: { approved: false },
          isError: true,
        };
      }
      const answers = await opts.ask({
        requestId: randomUUID(),
        sessionId: opts.sessionId,
        questions: [
          {
            question: EXIT_PLAN_QUESTION,
            header: "计划确认",
            options: [
              { label: EXIT_PLAN_APPROVE_LABEL, description: "关闭计划模式,按计划开始实施" },
              { label: "继续调整", description: "保持计划模式,继续完善计划" },
            ],
          },
        ],
      });
      const answer = (answers[EXIT_PLAN_QUESTION] ?? "").trim();
      if (answer === EXIT_PLAN_APPROVE_LABEL) {
        await opts.onApproved();
        return {
          content: [
            {
              type: "text",
              text: [
                "用户已批准计划。计划模式已关闭,全部工具已恢复。",
                "现在开始执行:第一步必须调用 TodoWrite,把计划拆成任务清单(每步一项,带 activeForm);",
                "之后每完成一个阶段目标,立即更新一次 TodoWrite 状态,不要攒到最后批量更新。",
              ].join("\n"),
            },
          ],
          details: { approved: true },
        };
      }
      if (answer) {
        return {
          content: [
            {
              type: "text",
              text: `用户暂未批准,仍在计划模式。用户的回复:「${answer}」。请按此继续完善计划,完成后再次调用 WritePlan 更新计划文件并重新展示,然后再调用 ExitPlanMode。`,
            },
          ],
          details: { approved: false },
        };
      }
      return {
        content: [
          { type: "text", text: "用户跳过了确认,仍在计划模式。等待用户进一步指示;若用户表达了执行意愿,再次调用 ExitPlanMode。" },
        ],
        details: { approved: false },
      };
    },
  };
}

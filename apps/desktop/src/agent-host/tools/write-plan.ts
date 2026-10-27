/**
 * WritePlan —— 计划模式下把完整计划写入会话专属的 PLAN.md。
 *
 * 文件固定在 ~/.spcode/plans/<sessionId>.md(应用自己的目录,不碰用户项目),
 * 原子写入;落盘后回调 onSaved,主进程据此把 planFile 回填进会话注册表。
 * 风险分级归 readonly:无副作用到用户文件,不弹权限卡。
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { writeFileAtomic } from "@spcode/shared/node";
import { type Static, Type } from "typebox";

const writePlanSchema = Type.Object({
  content: Type.String({
    description:
      "The complete plan in Markdown in the current UI language unless explicitly requested otherwise, written in full (no truncation)",
  }),
});

type Params = Static<typeof writePlanSchema>;

export function createWritePlanTool(opts: {
  plansDir: string;
  sessionId: string;
  onSaved: (path: string) => void;
}): ToolDefinition {
  return {
    name: "WritePlan",
    label: "Write Plan",
    description:
      "Save the complete plan to this session's PLAN.md. Call this once the plan is ready, then end the turn with only a brief summary and the returned plan: link. Do not repeat the plan text and do not ask for execution approval.",
    promptSnippet: "Save the plan and finish with a summary plus a plan: file link",
    parameters: writePlanSchema,
    execute: async (_id, args: Params) => {
      const content = args.content.trim();
      if (!content) {
        return {
          content: [{ type: "text", text: "Plan content is empty — nothing written." }],
          details: { presentation: { key: "agent:tool.planEmpty" } },
          isError: true,
        };
      }
      mkdirSync(opts.plansDir, { recursive: true });
      const file = join(opts.plansDir, `${opts.sessionId}.md`);
      writeFileAtomic(file, `${content}\n`);
      opts.onSaved(file);
      return {
        content: [
          {
            type: "text",
            text: `Plan saved: ${file}. End this turn now with a brief summary and [PLAN.md](plan:${file}). Do not repeat the plan content and do not ask whether to execute.`,
          },
        ],
        details: { path: file, presentation: { key: "agent:tool.planSaved", params: { path: file } } },
      };
    },
  };
}

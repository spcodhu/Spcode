/**
 * WritePlan —— 计划模式下把完整计划写入会话专属的 PLAN.md。
 *
 * 文件固定在 ~/.spcode/plans/<sessionId>.md(应用自己的目录,不碰用户项目),
 * 原子写入;落盘后回调 onSaved,主进程据此把 planFile 回填进会话注册表。
 * 风险分级归 readonly:无副作用到用户文件,不弹权限卡。
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const writePlanSchema = Type.Object({
  content: Type.String({ description: "The complete plan in Markdown, written in full (no truncation)" }),
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
      "Save the complete plan to this session's plan file (PLAN.md). Call this BEFORE presenting the plan in your reply: write the file first, then show the full plan text to the user. Overwrites any previous version of the plan.",
    promptSnippet: "Save the plan to the session's plan file before presenting it",
    parameters: writePlanSchema,
    execute: async (_id, args: Params) => {
      const content = args.content.trim();
      if (!content) {
        return {
          content: [{ type: "text", text: "Plan content is empty — nothing written." }],
          details: {},
          isError: true,
        };
      }
      mkdirSync(opts.plansDir, { recursive: true });
      const file = join(opts.plansDir, `${opts.sessionId}.md`);
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, content + "\n", "utf-8");
      renameSync(tmp, file);
      opts.onSaved(file);
      return {
        content: [{ type: "text", text: `计划已保存:${file}。现在请在回复正文里完整展示计划全文。` }],
        details: { path: file },
      };
    },
  };
}

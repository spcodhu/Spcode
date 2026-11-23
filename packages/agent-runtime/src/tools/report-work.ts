import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WorkerWorkReport } from "@spcode/shared/superagent";
import { type Static, Type } from "typebox";
import { STRICT_PREFER_TOOL_SAMPLING } from "./tool-schema.js";

const schema = Type.Object({
  status: Type.Union([Type.Literal("waiting"), Type.Literal("ready"), Type.Literal("blocked"), Type.Literal("failed")]),
  summary: Type.String({ minLength: 1 }),
  tests: Type.Array(
    Type.Object({
      command: Type.String({ minLength: 1 }),
      status: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("skipped")]),
      exitCode: Type.Optional(Type.Integer()),
      durationMs: Type.Optional(Type.Number({ minimum: 0 })),
      output: Type.Optional(Type.String()),
    }),
  ),
  commitMessage: Type.Optional(Type.String({ minLength: 1 })),
  artifacts: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});

type Params = Static<typeof schema>;

/** 唯一允许 Worker 宣告 ready 的结构化出口；自由文本不参与成功判定。 */
export function createReportWorkTool(onReport: (report: WorkerWorkReport) => void): ToolDefinition {
  return {
    name: "ReportWork",
    label: "Report Work",
    description:
      "Report structured execution status, change summary, test evidence, and an optional local commit message. Call exactly once when work is ready, blocked, waiting, or failed. A ready report does not perform a Git commit.",
    promptSnippet: "Finish execution with structured ReportWork evidence; never run Git write commands",
    parameters: schema,
    constrainedSampling: STRICT_PREFER_TOOL_SAMPLING,
    execute: async (_id, args: Params) => {
      const report: WorkerWorkReport = {
        status: args.status,
        summary: args.summary.trim(),
        tests: args.tests.map((test) => ({ ...test, command: test.command.trim() })),
        ...(args.commitMessage?.trim() ? { commitMessage: args.commitMessage.trim() } : {}),
        ...(args.artifacts?.length ? { artifacts: args.artifacts } : {}),
      };
      if (!report.summary || report.tests.some((test) => !test.command)) {
        return {
          content: [{ type: "text", text: "ReportWork requires a summary and non-empty test commands." }],
          details: undefined,
          isError: true,
        };
      }
      onReport(report);
      return {
        content: [{ type: "text", text: `Structured work report accepted: ${report.status}. End this turn now.` }],
        details: { report },
      };
    },
  };
}

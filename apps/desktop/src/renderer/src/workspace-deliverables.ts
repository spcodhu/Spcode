import { splitPlanLinks } from "./plan-links";
import type { ChatMessage } from "./store";

export interface WorkspaceDeliverable {
  path: string;
  label: string;
  kind: "plan" | "file";
}

/**
 * 会话文件列表只认助手正文明确分享给用户的本地文件链接。
 * 工具调用里的 read/write/edit 路径、用户消息和代码块示例都不进入列表。
 * 数据直接由会话消息派生，因此实时输出与重启后的历史回放走同一套规则。
 */
export function workspaceDeliverables(messages: ChatMessage[]): WorkspaceDeliverable[] {
  const out: WorkspaceDeliverable[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const segment of message.segments) {
      if (segment.kind !== "text") continue;
      for (const part of splitPlanLinks(segment.text)) {
        if (part.kind !== "file" && part.kind !== "plan") continue;
        const key = `${part.kind}:${part.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ path: part.path, label: part.label, kind: part.kind });
      }
    }
  }
  return out;
}

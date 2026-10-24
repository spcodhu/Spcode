/**
 * 权限模式（三档）的模型可见说明。
 *
 * 与计划模式同一套机制（sendCustomMessage + display:false）：模型知道当前问不问，
 * 才不会在「总不询问」档反复停下来等批准，也不会在「总是询问」档假设自己已被放行。
 * UI 不显示这些消息，避免污染对话流。
 */
import type { PermissionMode } from "@spcode/shared";

/** custom 消息类型（宿主内部使用；渲染层按 display:false 忽略） */
export const PERMISSION_MODE_CUSTOM_TYPE = "spcode.permission-mode";

const NOTES: Record<PermissionMode, string> = {
  ask: [
    "Permission mode: ALWAYS ASK.",
    "Every write operation and every shell command requires explicit user approval; only read-only tools run directly.",
    "Do not assume a previous approval covers the next call. If the user denies a call, adapt instead of retrying the same command.",
  ].join(" "),
  auto: [
    "Permission mode: ASK WHEN NECESSARY.",
    "Write operations (file edits and shell commands) run without asking.",
    "Outward-facing actions (git push, publishing, ssh/scp, deployment) and irreversible or dangerous commands (rm -rf, sudo, force push) still require approval, as does any request to run outside the sandbox.",
  ].join(" "),
  never: [
    "Permission mode: NEVER ASK.",
    "The user has disabled approval prompts: execute directly instead of waiting for confirmation.",
    "OS sandbox boundaries, credential read-deny rules and plan-mode restrictions still apply.",
    "If a command is blocked, adapt to the error; do not use dangerouslyDisableSandbox to work around a boundary.",
  ].join(" "),
};

export function permissionModeNote(mode: PermissionMode): string {
  return NOTES[mode];
}

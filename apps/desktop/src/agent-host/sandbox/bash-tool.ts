/**
 * 沙盒化 bash 工具 —— 以同名 customTool 覆盖 pi 内置 bash。
 *
 * pi 的工具注册表语义：customTools 与内置工具同名时 customTools 生效
 * （_refreshToolRegistry 中后写覆盖）。因此这里用 createBashToolDefinition
 * 保留内置工具的全部行为（流式输出、截断、进程树终止、超时），
 * 只把执行后端 operations.exec 替换为「先 SandboxManager.wrapWithSandbox
 * 包装，再委托 pi 原生本地执行」。
 *
 * 工具描述里向模型声明沙盒边界的存在——被拦截时模型能理解 EPERM/网络错误
 * 是预期行为并如实告知用户，而不是盲目重试。
 */
import { createBashToolDefinition, createLocalBashOperations, type BashOperations, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getSandboxService } from "./manager.js";

const SANDBOX_DESCRIPTION_NOTE =
  " Commands run inside an OS-enforced sandbox: writes are restricted to the working directory and system temp dirs, sensitive paths (~/.ssh, app credentials) are unreadable, and network access is limited to an allowlist of domains. If a command fails with EPERM / 'Operation not permitted' / 'Could not resolve host', it was blocked by the sandbox — do not retry blindly; report the restriction to the user.";

/** 违规注解尾部标记，渲染层/测试可据此识别 */
export const SANDBOX_VIOLATION_NOTE_HEADER = "[sandbox] restrictions hit during this command:";

export function createSandboxedBashTool(cwd: string): ToolDefinition {
  const sandbox = getSandboxService();
  const local = createLocalBashOperations();

  const sandboxedOps: BashOperations = {
    exec: async (command, execCwd, options) => {
      let wrapped: string;
      let commandId: string;
      try {
        ({ command: wrapped, commandId } = await sandbox.wrap(command, execCwd));
      } catch (err) {
        // fail-closed：包装失败绝不裸跑（那等于静默关闭沙盒）
        const message = err instanceof Error ? err.message : String(err);
        options.onData(
          Buffer.from(`Command not executed: sandbox wrapping failed (${message}). ` +
            `You may retry; if it persists, ask the user to check sandbox status in Settings.\n`),
        );
        return { exitCode: 126 };
      }
      const result = await local.exec(wrapped, execCwd, options);
      // 违规归因：把内核/代理拦截记录附到输出尾部，模型据此理解并回应
      const violations = sandbox.violations(commandId);
      if (violations.length > 0) {
        const lines = violations.map((v) => `  ${v.line}`).join("\n");
        options.onData(Buffer.from(`\n${SANDBOX_VIOLATION_NOTE_HEADER}\n${lines}\n`));
      }
      return result;
    },
  };

  const def = createBashToolDefinition(cwd, { operations: sandboxedOps });
  // 泛型方差：createBashToolDefinition 返回的是参数特化的 ToolDefinition，
  // 与注册表要求的通用 ToolDefinition 不直接相容，这里断言收窄（运行时结构一致）
  return {
    ...def,
    description: def.description + SANDBOX_DESCRIPTION_NOTE,
    promptGuidelines: [...(def.promptGuidelines ?? []), "Commands are sandboxed: filesystem writes outside the working directory and network access to non-allowlisted domains will be blocked by the OS."],
  } as unknown as ToolDefinition;
}

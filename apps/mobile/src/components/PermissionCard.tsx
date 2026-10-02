/**
 * 权限批准卡：permission.request 到达时全屏置顶。
 * - 显示工具名、参数摘要、risk 级别；
 * - danger 级：红色强提示 + 批准按钮需长按 1.5s 二次确认；
 * - 桌面与手机可能同时收到：回复后本地卡片消失即可（先到先得，对端忽略重复）。
 */

import type { PermissionRequest, ToolRisk } from "@spcode/shared";
import { useEffect, useRef, useState } from "react";
import { replyPermission } from "../state/controller";
import { useAppStore } from "../state/store";

const RISK_TEXT: Record<ToolRisk, string> = {
  readonly: "只读操作",
  write: "写入操作",
  danger: "危险操作",
};

const RISK_CLASS: Record<ToolRisk, string> = {
  readonly: "bg-slate-800 text-slate-300",
  write: "bg-amber-900/70 text-amber-300",
  danger: "bg-red-900/80 text-red-200",
};

function summarizeArgs(args: unknown): string {
  try {
    const s = JSON.stringify(args, null, 2) ?? "";
    return s.length > 2000 ? `${s.slice(0, 2000)}\n…（截断）` : s;
  } catch {
    return String(args);
  }
}

/** danger 级二次确认：长按 1.5s（带进度）才触发批准 */
function HoldToApproveButton({ onConfirm }: { onConfirm: () => void }) {
  const [progress, setProgress] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startRef = useRef(0);

  const clear = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    setProgress(0);
  };

  const start = () => {
    startRef.current = Date.now();
    timerRef.current = setInterval(() => {
      const p = (Date.now() - startRef.current) / 1500;
      if (p >= 1) {
        clear();
        onConfirm();
      } else {
        setProgress(p);
      }
    }, 30);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅在组件卸载时清理定时器
  useEffect(() => clear, []);

  return (
    <button
      type="button"
      onPointerDown={start}
      onPointerUp={clear}
      onPointerLeave={clear}
      onContextMenu={(e) => e.preventDefault()}
      className="relative flex-1 select-none overflow-hidden rounded-xl border border-red-700 py-3 text-sm font-medium text-red-200"
    >
      <span className="absolute inset-y-0 left-0 bg-red-700/60" style={{ width: `${progress * 100}%` }} />
      <span className="relative">{progress > 0 ? "继续按住…" : "长按确认允许"}</span>
    </button>
  );
}

export function PermissionCard({ request }: { request: PermissionRequest }) {
  const session = useAppStore((s) => s.sessions[request.sessionId]);
  const danger = request.risk === "danger";
  const [busy, setBusy] = useState(false);

  const reply = (approved: boolean) => {
    if (busy) return;
    setBusy(true);
    void replyPermission(request.requestId, approved);
  };

  return (
    <div className={`absolute inset-0 z-40 flex flex-col ${danger ? "bg-[#1a0b0b]" : "bg-[#0b0f14f2]"}`}>
      <div className="px-5 pt-10">
        <div className={`text-lg font-bold ${danger ? "text-red-300" : "text-amber-200"}`}>
          {danger ? "⚠️ 危险操作待批准" : "操作待批准"}
        </div>
        <div className="mt-1 text-xs text-slate-400">会话：{session?.title ?? request.sessionId}</div>
      </div>

      <div className="mx-5 mt-4 rounded-xl border border-slate-700 bg-slate-900/70 p-4">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold text-slate-100">{request.toolName}</span>
          <span className={`rounded-full px-2 py-0.5 text-[10px] ${RISK_CLASS[request.risk]}`}>
            {RISK_TEXT[request.risk]}
          </span>
        </div>
        <pre className="thin-scroll mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/40 p-3 font-mono text-[11px] leading-5 text-slate-300">
          {summarizeArgs(request.args)}
        </pre>
        {danger && (
          <div className="mt-3 rounded-lg border border-red-800 bg-red-950/60 px-3 py-2 text-xs leading-5 text-red-200">
            此操作风险级别为 danger，可能造成不可逆影响。请完整核对上方参数；确认无误后<strong>长按</strong>批准按钮。
          </div>
        )}
      </div>

      <div className="mt-auto flex gap-3 px-5 pb-[max(2rem,env(safe-area-inset-bottom))]">
        {danger ? (
          <HoldToApproveButton onConfirm={() => reply(true)} />
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => reply(true)}
            className="flex-1 rounded-xl bg-emerald-600 py-3 text-sm font-medium text-white active:bg-emerald-500 disabled:opacity-40"
          >
            允许
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => reply(false)}
          className="flex-1 rounded-xl bg-slate-800 py-3 text-sm font-medium text-slate-200 active:bg-slate-700 disabled:opacity-40"
        >
          拒绝
        </button>
      </div>
    </div>
  );
}

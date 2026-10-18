import type { UpdateState } from "@spcode/shared";
import { useState } from "react";
import { useStore } from "../store";
import { Icon } from "./Icon";

/**
 * 侧栏底部「更新」按钮（Finch 式手动更新）：
 * - 主进程发现新版本时出现（绝不自动下载）
 * - available：「更新」按钮 → 弹窗展示版本号与发布说明，可「确认更新」或「忽略此版本」
 * - downloading：按钮变为小进度条（点击可回看弹窗里的进度）
 * - downloaded：按钮变为「重启」→ 弹窗警告会话会中断，可「稍后」或「立即重启」
 * - error：红色「更新失败」→ 弹窗给原因与重试入口
 * - idle：不渲染
 */
export function UpdateButton() {
  const state = useStore((s) => s.updateState);
  const [open, setOpen] = useState(false);

  return (
    <>
      {state.status === "available" && (
        <button
          type="button"
          data-testid="update-button"
          onClick={() => setOpen(true)}
          title={`发现新版本 ${state.version}`}
          className="flex items-center gap-1 rounded-lg bg-accent/15 px-2 py-2 text-[12px] font-medium text-accent transition-colors hover:bg-accent/25"
        >
          <Icon name="arrowUp" size={14} strokeWidth={2.2} />
          更新
        </button>
      )}
      {state.status === "downloading" && (
        <button
          type="button"
          data-testid="update-button"
          onClick={() => setOpen(true)}
          title={`正在下载 ${state.version}`}
          className="relative h-8 w-[72px] overflow-hidden rounded-lg border border-border"
        >
          <span className="absolute inset-y-0 left-0 bg-accent/30" style={{ width: `${state.percent}%` }} />
          <span className="relative text-[11px] text-text-secondary">{Math.round(state.percent)}%</span>
        </button>
      )}
      {state.status === "downloaded" && (
        <button
          type="button"
          data-testid="update-button"
          onClick={() => setOpen(true)}
          title={`新版本 ${state.version} 已就绪，点击重启生效`}
          className="flex items-center gap-1 rounded-lg bg-accent px-2 py-2 text-[12px] font-medium text-white transition-colors hover:bg-accent-dim"
        >
          <Icon name="refresh" size={13} />
          重启
        </button>
      )}
      {state.status === "error" && (
        <button
          type="button"
          data-testid="update-button"
          onClick={() => setOpen(true)}
          title={state.message}
          className="flex items-center gap-1 rounded-lg bg-danger/15 px-2 py-2 text-[12px] text-danger transition-colors hover:bg-danger/25"
        >
          <Icon name="x" size={13} />
          更新失败
        </button>
      )}
      {open && state.status !== "idle" && <UpdateDialog state={state} onClose={() => setOpen(false)} />}
    </>
  );
}

/** 更新弹窗：版本信息 + 发布说明 + 各状态的操作区 */
function UpdateDialog({ state, onClose }: { state: UpdateState; onClose: () => void }) {
  const version = "version" in state ? state.version : "";
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 遮罩点外关闭（待统一 Modal 组件化收敛）；onClick 已改 onMouseDown 与其余弹层一致
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/55 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[440px] rounded-2xl border border-border bg-bg-elevated p-5 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-text-primary">
            {state.status === "downloaded"
              ? "重启以完成更新"
              : state.status === "error"
                ? "更新失败"
                : `发现新版本 ${version}`}
          </h2>
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            className="rounded-md p-1 text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
          >
            <Icon name="x" size={15} />
          </button>
        </div>

        {state.status === "available" && (
          <>
            <div className="mt-3 max-h-64 overflow-y-auto rounded-lg border border-border bg-bg-main px-3 py-2.5 text-[13px] leading-6 text-text-secondary whitespace-pre-wrap">
              {state.releaseNotes || "本次发布未附更新说明。"}
            </div>
            <div className="mt-4 flex items-center justify-between">
              <button
                type="button"
                onClick={() => {
                  void window.spcode.updateIgnore(state.version);
                  onClose();
                }}
                className="rounded-lg px-3 py-1.5 text-[12.5px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary"
              >
                忽略此版本
              </button>
              <button
                type="button"
                onClick={() => {
                  void window.spcode.updateDownload();
                  onClose();
                }}
                className="rounded-lg bg-accent px-4 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-accent-dim"
              >
                确认更新
              </button>
            </div>
          </>
        )}

        {state.status === "downloading" && (
          <>
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-bg-hover">
              <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${state.percent}%` }} />
            </div>
            <div className="mt-2 text-[12px] text-text-tertiary">
              正在下载 {state.version}… {Math.round(state.percent)}%
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg px-3 py-1.5 text-[12.5px] text-text-secondary transition-colors hover:bg-bg-hover"
              >
                后台下载
              </button>
            </div>
          </>
        )}

        {state.status === "downloaded" && (
          <>
            <p className="mt-3 text-[13px] leading-6 text-text-secondary">
              新版本 {state.version} 已下载完成。立即重启会中断正在进行的会话与任务。
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg px-3 py-1.5 text-[12.5px] text-text-secondary transition-colors hover:bg-bg-hover"
              >
                稍后
              </button>
              <button
                type="button"
                onClick={() => void window.spcode.updateInstall()}
                className="rounded-lg bg-accent px-4 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-accent-dim"
              >
                立即重启
              </button>
            </div>
          </>
        )}

        {state.status === "error" && (
          <>
            <p className="mt-3 break-all text-[13px] leading-6 text-text-secondary">{state.message}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg px-3 py-1.5 text-[12.5px] text-text-secondary transition-colors hover:bg-bg-hover"
              >
                关闭
              </button>
              <button
                type="button"
                onClick={() => {
                  void window.spcode.updateDownload();
                  onClose();
                }}
                className="rounded-lg bg-accent px-4 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-accent-dim"
              >
                重试下载
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

import type { ComposerDraft, ImageAttachment, ModelInfo, ModelRef, PermissionMode } from "@spcode/shared";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { buildFileBlocks, type DraftFile } from "../file-blocks";
import { formatCompact, formatFileSize } from "../format";
import { openImageContextMenu } from "../image-actions";
import { resolveImageRefs } from "../md-editor";
import { composerDraftKeyOf, type SessionState, useStore } from "../store";
import { thinkingLevelLabel } from "../tooling";
import { Icon } from "./Icon";
import { ImageLightbox } from "./ImageLightbox";
import { Markdown } from "./Markdown";
import { fileToAttachment, MdEditor, type MdEditorHandle } from "./MdEditor";
import { MdToolbar, type MdView } from "./MdToolbar";
import { Modal } from "./ui/Modal";

// ---------------------------------------------------------------------------
// 外部预填输入框（空态建议卡片等场景点击后把提示词填进输入框并聚焦）
// ---------------------------------------------------------------------------

const COMPOSER_PREFILL_EVENT = "spcode:composer-prefill";

export function prefillComposer(text: string): void {
  window.dispatchEvent(new CustomEvent(COMPOSER_PREFILL_EVENT, { detail: { text } }));
}

// ---------------------------------------------------------------------------
// Markdown 输入模式（文档式编辑区，独立于 plain 的 textarea）：
// - contentEditable 编辑器：文本为 raw markdown，图片内嵌 <img> 直显在对应位置
// - 编辑/预览切换（预览经 resolveImageRefs 把 ![name] 解析成内联 data URL）
// - 任意文件以 chip 挂载，发送时内容拼接进消息文本（引擎仅支持文本+图片）
// ---------------------------------------------------------------------------

/** 空附件常量（草稿缺省值复用同一引用，避免每次渲染新数组） */
const EMPTY_ATTACHMENTS: ImageAttachment[] = [];
const EMPTY_FILES: DraftFile[] = [];

export function Composer({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("chat");
  const session = useStore((s) => s.sessions[sessionId]);
  // 草稿按会话持久化：draft 会话用稳定 key，切换会话/点加号/重启 App 均恢复
  const draftKey = composerDraftKeyOf(session, sessionId);
  const draft = useStore((s) => s.composerDrafts[draftKey]);
  const text = draft?.text ?? "";
  const attachments = draft?.attachments ?? EMPTY_ATTACHMENTS;
  const files = draft?.files ?? EMPTY_FILES;
  const inputMode = draft?.inputMode ?? "plain";
  const setComposerDraft = useStore((s) => s.setComposerDraft);
  const clearComposerDraft = useStore((s) => s.clearComposerDraft);
  // 预览开关/图片预览为瞬态 UI 状态，不入草稿（分屏/预览三态）
  const [mdView, setMdView] = useState<MdView>("edit");
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);
  const running = session?.running ?? false;
  const models = useStore((s) => s.models);
  const settings = useStore((s) => s.settings);
  const sendPrompt = useStore((s) => s.sendPrompt);
  const abort = useStore((s) => s.abort);
  const setModel = useStore((s) => s.setModel);
  const setThinkingLevel = useStore((s) => s.setThinkingLevel);
  const setPlanMode = useStore((s) => s.setPlanMode);
  const setPermissionMode = useStore((s) => s.setPermissionMode);
  const compactSession = useStore((s) => s.compactSession);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mdEditorRef = useRef<MdEditorHandle>(null);
  // 每个草稿独立记录本地编辑修订：发送清空不算新编辑，发送后的输入/附件变化才算。
  const draftRevisionsRef = useRef(new Map<string, number>());
  const markDraftEdited = () => {
    const revisions = draftRevisionsRef.current;
    revisions.set(draftKey, (revisions.get(draftKey) ?? 0) + 1);
  };
  const updateDraft = (patch: Partial<Omit<ComposerDraft, "updatedAt">>) => {
    markDraftEdited();
    setComposerDraft(draftKey, patch);
  };

  /** 追加附件/文件：读 getState 最新值，避免异步回调里的旧闭包覆盖并发追加 */
  const appendToDraft = (field: "attachments" | "files", items: ImageAttachment[] | DraftFile[]) => {
    const cur = useStore.getState().composerDrafts[draftKey];
    markDraftEdited();
    setComposerDraft(draftKey, { [field]: [...(cur?.[field] ?? []), ...items] });
  };

  // 监听外部预填请求：已有草稿追加两个换行，空草稿直接填入；随后聚焦并把光标移到末尾
  // biome-ignore lint/correctness/useExhaustiveDependencies: updateDraft 随 draftKey 重建，只需在 key 变化时重绑
  useEffect(() => {
    const onPrefill = (e: Event) => {
      const text = (e as CustomEvent<{ text: string }>).detail?.text ?? "";
      const currentText = useStore.getState().composerDrafts[draftKey]?.text ?? "";
      const nextText = currentText ? `${currentText}\n\n${text}` : text;
      updateDraft({ text: nextText });
      requestAnimationFrame(() => {
        const mode = useStore.getState().composerDrafts[draftKey]?.inputMode ?? "plain";
        if (mode === "markdown") {
          mdEditorRef.current?.focusAtEnd();
          return;
        }
        const el = textareaRef.current;
        el?.focus();
        el?.setSelectionRange(nextText.length, nextText.length);
      });
    };
    window.addEventListener(COMPOSER_PREFILL_EVENT, onPrefill);
    return () => window.removeEventListener(COMPOSER_PREFILL_EVENT, onPrefill);
  }, [draftKey]);

  /* 高度自适应交给 CSS field-sizing: content（见 styles.css .composer-textarea）：
     不再用 JS 重算 height——那样每次输入先把高度归零再撑开，会把外层滚动容器的
     scrollTop 夹回 0（表现为多行输入时每敲一个字就跳回顶部）。 */

  const canSend = !!text.trim() || attachments.length > 0 || files.length > 0;
  const planMode = session?.planMode ?? false;
  const mdMode = inputMode === "markdown";
  // 预览文本：仅需要预览时计算（分屏/预览；含大 base64，避免每次渲染都算）
  const needPreview = mdMode && (mdView === "preview" || mdView === "split");
  const previewText = needPreview ? resolveImageRefs(text, attachments) : "";

  const send = () => {
    // 运行中不拦截：发送即 steer 插话（后端 session.prompt 在运行中走 steer，评审 R3-C11）
    if (!canSend) return;
    const value = text.trim() + buildFileBlocks(files);
    const imgs = attachments;
    const fileMeta = files.map(({ name, size }) => ({ name, size }));
    // 乐观清空 + 失败恢复快照。key/修订在发起时固定，迟到结果不能写入别的会话或新草稿。
    const sentDraftKey = draftKey;
    const snapshot = useStore.getState().composerDrafts[sentDraftKey];
    const sentRevision = draftRevisionsRef.current.get(sentDraftKey) ?? 0;
    clearComposerDraft(sentDraftKey);
    void sendPrompt(value, imgs.length ? imgs : undefined, fileMeta.length ? fileMeta : undefined).then((ok) => {
      if (ok || !snapshot) return;
      const hasLocalEdits = (draftRevisionsRef.current.get(sentDraftKey) ?? 0) !== sentRevision;
      const currentDraft = useStore.getState().composerDrafts[sentDraftKey];
      // currentDraft 还覆盖组件重挂载后由其他实例产生的编辑（updatedAt 已是新修订）。
      if (hasLocalEdits || currentDraft) return;
      useStore.getState().setComposerDraft(sentDraftKey, {
        text: snapshot.text,
        attachments: snapshot.attachments,
        files: snapshot.files,
        inputMode: snapshot.inputMode,
      });
    });
    requestAnimationFrame(() => {
      if (mdMode) mdEditorRef.current?.focus();
      else textareaRef.current?.focus();
    });
  };

  /** 添加图片：MD 模式内嵌到编辑器光标处（图片显示在对应位置）；plain 模式挂顶部附件 chips */
  const pickAttachments = async () => {
    const imgs = await window.spcode.pickImages().catch(() => []);
    if (!imgs.length) return;
    if (mdMode) {
      // 预览态下编辑器未挂载：先切回编辑态再插入（光标兜底到末尾）
      if (mdView === "preview") setMdView("edit");
      requestAnimationFrame(() => mdEditorRef.current?.insertImages(imgs));
    } else {
      appendToDraft("attachments", imgs);
    }
  };

  /** MD 模式「添加文件」：图片走附件通道，文本文件进 chips，二进制/超大提示拒绝 */
  const pickFiles = async () => {
    const picked = await window.spcode.pickFiles().catch(() => []);
    if (!picked.length) return;
    const rejected: string[] = [];
    const newFiles: DraftFile[] = [];
    const newImages: ImageAttachment[] = [];
    for (const f of picked) {
      if (f.kind === "image") newImages.push({ name: f.name, mimeType: f.mimeType, data: f.data });
      else if (f.kind === "text") newFiles.push({ name: f.name, size: f.size, text: f.text });
      else rejected.push(t("composer.rejectedFile", { name: f.name, reason: f.reason }));
    }
    if (newImages.length) appendToDraft("attachments", newImages);
    if (newFiles.length) appendToDraft("files", newFiles);
    if (rejected.length)
      useStore.setState({ notice: { text: t("composer.filesRejected", { files: rejected.join("\n") }) } });
  };

  // plain 模式粘贴：图片 → 附件 chips（MD 模式的粘贴由 MdEditor 自行处理）
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imgFiles = Array.from(e.clipboardData?.items ?? [])
      .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f && f.size <= 10 * 1024 * 1024);
    if (imgFiles.length === 0) return;
    e.preventDefault();
    void Promise.all(imgFiles.map((f, i) => fileToAttachment(f, i))).then((imgs) => appendToDraft("attachments", imgs));
  };

  // 权限模式：按会话生效（草稿会话只存本地，首次发送时同步给宿主）
  const permissionMode: PermissionMode = session?.permissionMode ?? settings?.permissionMode ?? "ask";
  /** 待确认的目标档位（切到「总不询问」需二次确认） */
  const [pendingMode, setPendingMode] = useState<PermissionMode | null>(null);
  const pickPermissionMode = (next: PermissionMode) => {
    if (next === permissionMode) return;
    if (next === "never") {
      setPendingMode(next);
      return;
    }
    void setPermissionMode(next);
  };
  /** Shift+Tab 循环：总是询问 → 必要时询问 → 总不询问 → 总是询问 */
  const cyclePermissionMode = () => {
    const order: PermissionMode[] = ["ask", "auto", "never"];
    pickPermissionMode(order[(order.indexOf(permissionMode) + 1) % order.length] ?? "ask");
  };
  // 仅在真正的文本编辑区里用 Shift+Tab 循环权限；工具栏/按钮保持标准反向焦点导航。
  const composerRootRef = useRef<HTMLDivElement>(null);
  const cycleRef = useRef(cyclePermissionMode);
  cycleRef.current = cyclePermissionMode;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !e.shiftKey || e.isComposing) return;
      const target = e.target;
      if (!(target instanceof Node) || !composerRootRef.current?.contains(target)) return;
      const isPlainEditor = target === textareaRef.current;
      const isMarkdownEditor =
        target instanceof HTMLElement &&
        target.getAttribute("data-testid") === "md-editor" &&
        target.getAttribute("contenteditable") === "true";
      if (!isPlainEditor && !isMarkdownEditor) return;
      e.preventDefault();
      cycleRef.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
  const enabledModels = models.filter(
    (m) =>
      !(settings?.disabledProviders ?? []).includes(m.provider) &&
      !(settings?.disabledModels ?? []).includes(`${m.provider}/${m.modelId}`),
  );

  /** 预览区内容（分屏/预览共用；空态给轻提示） */
  const previewBody =
    text.trim() || attachments.length > 0 ? (
      <Markdown text={previewText} />
    ) : (
      <div className="text-[14px] leading-6 text-text-tertiary">{t("composer.emptyPreview")}</div>
    );

  return (
    <div ref={composerRootRef} className="shrink-0 px-6 pb-4 pt-1">
      <div className="mx-auto max-w-3xl">
        <div
          className={`relative rounded-2xl border bg-bg-elevated shadow-lg transition-colors ${
            planMode
              ? "border-accent/40 focus-within:border-accent/70"
              : "border-border focus-within:border-border-strong"
          }`}
        >
          {/* 右上角：仅计划模式挂签（长文本的视图三态与退出在编辑器工具栏右端，不再挤在边框上）。
              right-10：让开 MD 工具栏最右的退出按钮，避免 3px 点击重叠 */}
          {planMode && (
            <div className="absolute -top-[11px] right-10 z-10">
              <button
                type="button"
                onClick={() => void setPlanMode(false)}
                title={t("composer.planActiveHint")}
                className="flex items-center gap-1 rounded-full bg-accent px-2.5 py-[3px] text-[11px] font-medium text-on-accent shadow-md transition-colors hover:bg-accent-dim"
              >
                <Icon name="clipboardCheck" size={11} strokeWidth={2.2} />
                {t("common.planMode")}
              </button>
            </div>
          )}
          {/* 图片附件 chips（仅 plain 模式；MD 模式图片内嵌在编辑器对应位置） */}
          {!mdMode && attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3.5 pt-3">
              {attachments.map((img, i) => (
                <div key={`${img.name}-${img.data.length}`} className="group/chip relative">
                  <button
                    type="button"
                    onClick={() => setPreviewIdx(i)}
                    title={t("common.previewFile", { name: img.name })}
                    className="cursor-zoom-in"
                  >
                    <img
                      src={`data:${img.mimeType};base64,${img.data}`}
                      alt={img.name}
                      data-testid="composer-image"
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void openImageContextMenu(img);
                      }}
                      className="h-12 w-12 rounded-lg border border-border object-cover"
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => updateDraft({ attachments: attachments.filter((_, j) => j !== i) })}
                    title={t("common.removeFile", { name: img.name })}
                    className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-bg-active text-text-tertiary opacity-0 transition-opacity hover:text-text-primary group-hover/chip:opacity-100"
                  >
                    <Icon name="x" size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {/* 输入区：plain 模式为自适应 textarea（field-sizing，不滚动外层）；
              MD 模式为文档式编辑区：工具栏 + 编辑/分屏/预览三态 */}
          {mdMode ? (
            <>
              <MdToolbar
                view={mdView}
                onViewChange={setMdView}
                onExit={() => {
                  updateDraft({ inputMode: "plain" });
                  setMdView("edit");
                }}
                onAction={(a) => mdEditorRef.current?.applyAction(a)}
                onPickImages={() => void pickAttachments()}
              />
              {mdView === "edit" && (
                <div className="max-h-[46vh] min-h-[180px] overflow-y-auto px-4 pb-2 pt-4">
                  <MdEditor
                    ref={mdEditorRef}
                    draftKey={draftKey}
                    text={text}
                    attachments={attachments}
                    placeholder={t("composer.markdownPlaceholder")}
                    onSync={(nextText, nextAtts) => updateDraft({ text: nextText, attachments: nextAtts })}
                    onSend={send}
                  />
                </div>
              )}
              {mdView === "split" && (
                <div className="grid max-h-[46vh] min-h-[180px] grid-cols-2 divide-x divide-border">
                  <div className="overflow-y-auto px-4 py-4">
                    <MdEditor
                      ref={mdEditorRef}
                      draftKey={draftKey}
                      text={text}
                      attachments={attachments}
                      placeholder={t("composer.splitPlaceholder")}
                      onSync={(nextText, nextAtts) => updateDraft({ text: nextText, attachments: nextAtts })}
                      onSend={send}
                    />
                  </div>
                  <div className="overflow-y-auto px-4 py-4">{previewBody}</div>
                </div>
              )}
              {mdView === "preview" && (
                <div className="max-h-[46vh] min-h-[180px] overflow-y-auto px-4 pb-2 pt-4">{previewBody}</div>
              )}
            </>
          ) : (
            <div className="px-4 pb-1 pt-3.5">
              <textarea
                ref={textareaRef}
                value={text}
                onChange={(e) => updateDraft({ text: e.target.value })}
                onPaste={handlePaste}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    send();
                  }
                }}
                data-testid="composer-input"
                aria-label={t("composer.placeholder")}
                placeholder={t("composer.placeholder")}
                rows={2}
                className="composer-textarea block max-h-[200px] w-full resize-none overflow-y-auto bg-transparent text-[14px] leading-6 outline-none placeholder:text-text-tertiary"
              />
            </div>
          )}

          {/* 文件附件 chips（MD 模式「添加文件」；输入区与工具栏之间，发送时内容随消息发出） */}
          {files.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3.5 pb-2">
              {files.map((f, i) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: 附件 chips 只增删不重排，index 参与 key 无副作用
                  key={`${f.name}-${i}`}
                  title={t("composer.fileHint", { name: f.name })}
                  className="flex items-center gap-1.5 rounded-lg border border-border bg-bg-main px-2 py-1 text-[12px] text-text-secondary"
                >
                  <Icon name="fileText" size={12} className="shrink-0 text-text-tertiary" />
                  <span className="max-w-56 truncate">{f.name}</span>
                  <span className="shrink-0 text-text-tertiary">{formatFileSize(f.size)}</span>
                  <button
                    type="button"
                    onClick={() => updateDraft({ files: files.filter((_, j) => j !== i) })}
                    title={t("common.removeFile", { name: f.name })}
                    className="shrink-0 text-text-tertiary transition-colors hover:text-text-primary"
                  >
                    <Icon name="x" size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* 底部胶囊工具栏 */}
          <div className="flex items-center gap-1.5 px-2.5 pb-2.5">
            {/* 图片：plain 模式挂附件 chips；MD 模式在编辑器工具栏里（内嵌到光标处） */}
            {!mdMode && (
              <ToolButton title={t("composer.addImage")} onClick={() => void pickAttachments()}>
                <Icon name="plus" size={16} />
              </ToolButton>
            )}

            {/* 长文本输入入口（MD 模式内的退出按钮在编辑器工具栏右端，同一 testid 不同时出现） */}
            {!mdMode && (
              <button
                type="button"
                data-testid="md-mode-toggle"
                onClick={() => {
                  updateDraft({ inputMode: "markdown" });
                  setMdView("edit");
                }}
                title={t("composer.longTextHint")}
                className="flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary"
              >
                <Icon name="pen" size={13} />
                {t("composer.longText")}
              </button>
            )}

            {/* MD 模式专属：添加文件（图片在工具栏，视图三态在工具栏右侧） */}
            {mdMode && (
              <ToolButton title={t("composer.addFile")} onClick={() => void pickFiles()}>
                <Icon name="fileText" size={15} />
              </ToolButton>
            )}

            {/* 权限模式（三档，按会话生效） */}
            <PermissionModeMenu
              mode={permissionMode}
              sandboxState={session?.sandbox?.state}
              onPick={pickPermissionMode}
            />

            {/* 计划模式 */}
            <button
              type="button"
              onClick={() => void setPlanMode(!planMode)}
              title={t(planMode ? "composer.exitPlan" : "composer.enterPlan")}
              data-testid="composer-plan-mode"
              className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] transition-colors ${
                planMode ? "bg-accent/20 text-accent" : "text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
              }`}
            >
              <Icon name={planMode ? "clipboardCheck" : "clipboard"} size={13} />
              {t("composer.plan")}
            </button>

            <div className="flex-1" />

            {/* 上下文占用环（悬浮看明细 + 手动压缩入口） */}
            {settings?.quickQuota && session?.meta.model && (
              <ContextRing
                model={session.meta.model}
                lastUsage={session.lastUsage}
                models={models}
                compacting={session.compacting === true}
                busy={session.running}
                onCompact={() => void compactSession()}
              />
            )}

            {/* 模型选择（两级弹出菜单） */}
            <ModelMenu
              models={enabledModels}
              value={session?.meta.model ?? null}
              thinkingLevel={session?.meta.thinkingLevel ?? ""}
              thinkingLevels={session?.supportedThinkingLevels ?? []}
              onChange={(ref) => void setModel(ref)}
              onThinkingChange={(lv) => void setThinkingLevel(lv)}
            />

            {/* 发送 / 停止（运行中并存：发送 = steer 插话，不打断当前运行） */}
            {running && (
              <button
                type="button"
                onClick={() => void abort()}
                title={t("common.stop")}
                aria-label={t("common.stop")}
                data-testid="composer-stop"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-danger/15 text-danger transition-colors hover:bg-danger/25"
              >
                <span className="text-[11px]">■</span>
              </button>
            )}
            <button
              type="button"
              onClick={send}
              disabled={!canSend}
              title={t(running ? "composer.steer" : "common.send")}
              aria-label={t(running ? "composer.steer" : "common.send")}
              data-testid="composer-send"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-on-accent transition-colors hover:bg-accent-dim disabled:opacity-30"
            >
              <Icon name="arrowUp" size={16} strokeWidth={2.2} />
            </button>
          </div>
        </div>
      </div>
      {previewIdx !== null && (
        <ImageLightbox
          images={attachments}
          index={previewIdx}
          onClose={() => setPreviewIdx(null)}
          onNavigate={setPreviewIdx}
        />
      )}
      {pendingMode === "never" && (
        <PermissionModeConfirm
          onCancel={() => setPendingMode(null)}
          onConfirm={() => {
            setPendingMode(null);
            void setPermissionMode("never");
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 权限模式（三档）：胶囊按钮 + 弹层菜单
// ---------------------------------------------------------------------------

const PERMISSION_MODE_STYLE: Record<PermissionMode, { icon: string; tone: string; iconTone: string }> = {
  ask: {
    icon: "shield",
    tone: "text-text-tertiary hover:bg-bg-hover hover:text-text-secondary",
    iconTone: "text-text-tertiary",
  },
  auto: {
    icon: "shieldCheck",
    tone: "bg-accent/15 text-accent hover:bg-accent/25",
    iconTone: "text-accent",
  },
  never: {
    icon: "zap",
    tone: "bg-danger/15 text-danger hover:bg-danger/25",
    iconTone: "text-danger",
  },
};

function PermissionModeMenu({
  mode,
  sandboxState,
  onPick,
}: {
  mode: PermissionMode;
  sandboxState?: "active" | "disabled" | "unavailable";
  onPick: (mode: PermissionMode) => void;
}) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const active = PERMISSION_MODE_STYLE[mode];
  const options = [
    { mode: "ask" as const, label: t("composer.modeAsk"), hint: t("composer.modeAskHint") },
    { mode: "auto" as const, label: t("composer.modeAuto"), hint: t("composer.modeAutoHint") },
    { mode: "never" as const, label: t("composer.modeNever"), hint: t("composer.modeNeverHint") },
  ];
  const activeLabel = options.find((o) => o.mode === mode)?.label ?? "";
  const activeHint = options.find((o) => o.mode === mode)?.hint ?? "";
  // 沙盒未生效时，「必要时询问」「总不询问」的自动放行没有内核兜底，必须当面提醒
  const sandboxInactive = sandboxState !== undefined && sandboxState !== "active";
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        title={activeHint}
        data-testid="composer-permission-mode"
        data-mode={mode}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] transition-colors ${active.tone}`}
      >
        <Icon name={active.icon} size={13} />
        {activeLabel}
        {sandboxInactive && mode !== "ask" && <Icon name="alert" size={11} className="shrink-0" />}
      </button>

      {open && (
        <div
          role="menu"
          data-testid="permission-mode-menu"
          className="absolute bottom-9 left-0 z-50 w-80 rounded-2xl border border-border bg-bg-elevated p-1.5 shadow-2xl"
        >
          {options.map((o) => {
            const ui = PERMISSION_MODE_STYLE[o.mode];
            const current = o.mode === mode;
            return (
              <button
                type="button"
                key={o.mode}
                role="menuitemradio"
                aria-checked={current}
                data-testid={`permission-mode-option-${o.mode}`}
                onClick={() => {
                  setOpen(false);
                  onPick(o.mode);
                }}
                className={`flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-bg-hover ${
                  current ? "bg-bg-hover/60" : ""
                }`}
              >
                <Icon name={ui.icon} size={15} className={`mt-0.5 shrink-0 ${ui.iconTone}`} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] text-text-primary">{o.label}</span>
                  <span className="mt-0.5 block text-[11.5px] leading-snug text-text-tertiary">{o.hint}</span>
                </span>
                {current && <Icon name="check" size={14} className="mt-0.5 shrink-0 text-accent" />}
              </button>
            );
          })}
          <div className="mt-1 border-t border-border px-2.5 pb-1 pt-2 text-[11px] leading-snug text-text-tertiary">
            {t("composer.modeMenuHint")}
            {sandboxInactive && mode !== "ask" && (
              <div data-testid="permission-mode-sandbox-warning" className="mt-1 text-danger">
                {t("composer.modeSandboxWarning")}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** 切到「总不询问」的二次确认：把不可逆后果说清楚，默认不启用 */
function PermissionModeConfirm({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const { t } = useTranslation("chat");
  return (
    <Modal
      title={t("composer.modeNeverConfirmTitle")}
      role="alertdialog"
      onClose={onCancel}
      layerClassName="items-center justify-center"
      panelClassName="w-[420px] max-w-[92vw] rounded-xl border border-danger/40 bg-bg-elevated shadow-2xl"
      testId="permission-mode-confirm"
    >
      <div className="rounded-t-xl bg-danger/10 px-4 py-3">
        <div className="text-sm font-semibold text-danger">{t("composer.modeNeverConfirmTitle")}</div>
      </div>
      <div className="px-4 py-3 text-[12.5px] leading-relaxed text-text-secondary">
        {t("composer.modeNeverConfirmBody")}
      </div>
      <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
        <button
          type="button"
          data-testid="permission-mode-confirm-cancel"
          onClick={onCancel}
          className="rounded-md border border-border px-4 py-1.5 text-xs text-text-secondary hover:bg-bg-hover"
        >
          {t("composer.modeNeverConfirmCancel")}
        </button>
        <button
          type="button"
          data-testid="permission-mode-confirm-ok"
          onClick={onConfirm}
          className="rounded-md bg-danger px-4 py-1.5 text-xs font-medium text-on-danger hover:bg-danger/80"
        >
          {t("composer.modeNeverConfirmOk")}
        </button>
      </div>
    </Modal>
  );
}

function ToolButton({ children, title, onClick }: { children: React.ReactNode; title: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-full text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary"
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// 上下文占用环：当前会话最近一次请求的上下文占用 / 模型上下文窗口
// 悬浮显示自绘明细卡（不用原生 title，深色主题下原生提示太违和）+ 手动压缩入口
// ---------------------------------------------------------------------------

function ContextRing({
  model,
  lastUsage,
  models,
  compacting,
  busy,
  onCompact,
}: {
  model: ModelRef;
  lastUsage: SessionState["lastUsage"];
  models: ModelInfo[];
  compacting: boolean;
  /** 会话运行中（手动压缩会先 abort 运行，不在中途插入，故运行中禁用） */
  busy: boolean;
  onCompact: () => void;
}) {
  const { t } = useTranslation("chat");
  const info = models.find((m) => m.provider === model.provider && m.modelId === model.modelId);
  const window = info?.contextWindow ?? 0;
  if (window <= 0) return null;

  // 上下文占用 = 最近一次请求的 input + cacheRead + cacheWrite + output（= 引擎压缩判断的
  // totalTokens 口径）。漏掉 cacheWrite 会让冷缓存请求显示失真小数字（缓存 TTL 过期后
  // 上下文大头全计在 cacheWrite 上），环出现「突然变小又变大」的跳动。
  const used = lastUsage ? lastUsage.input + lastUsage.cacheRead + lastUsage.cacheWrite + lastUsage.output : 0;
  const pct = Math.min(100, Math.round((used / window) * 100));
  const color = pct >= 90 ? "var(--color-danger)" : pct >= 70 ? "var(--color-warning)" : "var(--color-accent)";

  const R = 7;
  const C = 2 * Math.PI * R;
  return (
    <div className="group relative flex h-7 w-7 items-center justify-center">
      <svg width="18" height="18" viewBox="0 0 18 18" role="img" aria-label={t("context.percent", { percent: pct })}>
        <circle cx="9" cy="9" r={R} fill="none" stroke="var(--color-bg-hover)" strokeWidth="2.5" />
        <circle
          cx="9"
          cy="9"
          r={R}
          fill="none"
          stroke={color}
          strokeWidth="2.5"
          strokeDasharray={`${(pct / 100) * C} ${C}`}
          strokeLinecap="round"
          transform="rotate(-90 9 9)"
        />
      </svg>
      {/* 悬浮明细卡 */}
      <div className="pointer-events-none absolute bottom-8 right-0 z-50 w-64 rounded-xl border border-border bg-bg-elevated p-3 opacity-0 shadow-2xl transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100">
        <div className="flex items-baseline justify-between">
          <span className="text-[13px] font-medium text-text-primary">{t("context.title")}</span>
          <span className="text-[13px] text-text-secondary">
            {t("context.usage", { used: formatCompact(used), total: formatCompact(window), percent: pct })}
          </span>
        </div>
        {lastUsage ? (
          <div className="mt-2 space-y-1 text-[12px]">
            <div className="flex justify-between">
              <span className="text-text-tertiary">{t("context.inputCache")}</span>
              <span className="text-text-secondary">
                {lastUsage.input.toLocaleString()} / {lastUsage.cacheRead.toLocaleString()} /
                {lastUsage.cacheWrite.toLocaleString()}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-tertiary">{t("context.output")}</span>
              <span className="text-text-secondary">{lastUsage.output.toLocaleString()}</span>
            </div>
          </div>
        ) : (
          <div className="mt-2 text-[12px] text-text-tertiary">{t("context.empty")}</div>
        )}
        <button
          type="button"
          data-testid="compact-now"
          disabled={compacting || busy}
          onClick={onCompact}
          className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-lg border border-border px-2 py-1.5 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45"
        >
          {t(compacting ? "context.compacting" : "context.compactNow")}
        </button>
        <div className="mt-1.5 text-[11px] leading-snug text-text-tertiary">{t("context.hint")}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 模型菜单：胶囊 → 上弹面板（模型行 + 推理强度行 → 各自二级列表）
// ---------------------------------------------------------------------------

export interface ModelOption {
  provider: string;
  modelId: string;
  displayName: string;
}

type MenuView = "main" | "models" | "levels";

export function ModelMenu({
  models,
  value,
  thinkingLevel,
  thinkingLevels,
  onChange,
  onThinkingChange,
}: {
  models: ModelOption[];
  value: ModelRef | null;
  thinkingLevel: string;
  thinkingLevels: string[];
  onChange: (ref: ModelRef) => void;
  onThinkingChange: (level: string) => void;
}) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<MenuView>("main");
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const selectedOptionRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (view !== "main") {
        setView("main");
      } else {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, view]);

  // 打开主菜单时聚焦第一项；进入二级列表时聚焦并滚动到当前值。
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const target =
        view === "main"
          ? panelRef.current?.querySelector<HTMLElement>("[data-menu-option]")
          : (selectedOptionRef.current ?? panelRef.current?.querySelector<HTMLElement>("[data-menu-option]"));
      target?.focus();
      if (view === "models") selectedOptionRef.current?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, view]);

  const current = value ? models.find((m) => m.provider === value.provider && m.modelId === value.modelId) : null;
  const pillText = current
    ? thinkingLevel && thinkingLevel !== "off"
      ? t("model.withThinking", { model: current.displayName, level: thinkingLevelLabel(thinkingLevel) })
      : current.displayName
    : t("common.selectModel");
  const groups = new Map<string, ModelOption[]>();
  const nameCounts = new Map<string, number>();
  for (const m of models) {
    const group = groups.get(m.provider) ?? [];
    group.push(m);
    groups.set(m.provider, group);
    const nameKey = `${m.provider}/${m.displayName}`;
    nameCounts.set(nameKey, (nameCounts.get(nameKey) ?? 0) + 1);
  }
  const firstModelKey = models[0] ? `${models[0].provider}/${models[0].modelId}` : "";

  const closeWithTriggerFocus = () => {
    setOpen(false);
    requestAnimationFrame(() => buttonRef.current?.focus());
  };
  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const options = Array.from(panelRef.current?.querySelectorAll<HTMLElement>("[data-menu-option]") ?? []);
    if (options.length === 0) return;
    e.preventDefault();
    const index = options.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? options.length - 1
          : index < 0
            ? e.key === "ArrowDown"
              ? 0
              : options.length - 1
            : e.key === "ArrowDown"
              ? (index + 1) % options.length
              : (index - 1 + options.length) % options.length;
    options[next]?.focus();
  };

  return (
    <div ref={rootRef} className="relative">
      {/* 胶囊按钮 */}
      <button
        ref={buttonRef}
        type="button"
        data-testid="composer-model-menu"
        aria-label={t("common.selectModel")}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? "composer-model-popup" : undefined}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setOpen(true);
            setView("main");
          }
        }}
        onClick={() => {
          setOpen(!open);
          setView("main");
        }}
        className="flex items-center gap-1 rounded-full border border-border bg-bg-main px-2.5 py-1 text-[12px] text-text-secondary transition-colors hover:border-border-strong"
      >
        <Icon name="cpu" size={13} className="text-text-tertiary" />
        <span className="max-w-44 truncate">{pillText}</span>
        <Icon name="chevronDown" size={11} className="text-text-tertiary" />
      </button>

      {/* 弹出面板 */}
      {open && (
        <div
          id="composer-model-popup"
          ref={panelRef}
          role="dialog"
          aria-label={t("common.model")}
          onKeyDown={onMenuKeyDown}
          className="absolute bottom-9 right-0 z-50 w-80 rounded-2xl border border-border bg-bg-elevated p-2 shadow-2xl"
        >
          {view === "main" && (
            <>
              <div className="px-2.5 pb-1 pt-1.5 text-[12px] text-text-tertiary">{t("common.model")}</div>
              <button
                type="button"
                data-menu-option
                data-testid="composer-open-models"
                onClick={() => setView("models")}
                className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2.5 hover:bg-bg-hover"
              >
                <Icon name="cpu" size={16} className="shrink-0 text-text-tertiary" />
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-[14px] text-text-primary">
                    {current?.displayName ?? t("common.selectModel")}
                  </span>
                  <span className="block truncate text-[12px] text-text-tertiary">{value?.provider ?? ""}</span>
                </span>
                <Icon name="chevronRight" size={14} className="shrink-0 text-text-tertiary" />
              </button>
              <div className="my-1.5 border-t border-border" />
              <button
                type="button"
                data-menu-option
                data-testid="composer-open-levels"
                onClick={() => thinkingLevels.length > 0 && setView("levels")}
                className={`w-full rounded-xl bg-bg-hover/60 px-2.5 py-2.5 ${thinkingLevels.length === 0 ? "opacity-50" : "hover:bg-bg-hover"}`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon name="brain" size={15} className="shrink-0 text-text-tertiary" />
                  <span className="flex-1 text-left text-[14px] text-text-primary">
                    {t("model.thinkingValue", { level: thinkingLevelLabel(thinkingLevel || "off") })}
                  </span>
                  {thinkingLevels.length > 0 && (
                    <Icon name="chevronRight" size={14} className="shrink-0 text-text-tertiary" />
                  )}
                </span>
              </button>
            </>
          )}

          {view === "models" && (
            <>
              <MenuHeader title={t("common.selectModel")} onBack={() => setView("main")} />
              <div className="max-h-80 overflow-y-auto" role="listbox" aria-label={t("common.selectModel")}>
                {models.length === 0 && (
                  <div className="px-3 py-4 text-[12px] text-text-tertiary">{t("model.empty")}</div>
                )}
                {[...groups].map(([provider, items]) => (
                  <fieldset key={provider} aria-label={provider} className="mb-1 min-w-0 last:mb-0">
                    <div
                      className="px-2.5 pb-1 pt-2 text-[11px] font-medium text-text-tertiary"
                      data-testid="composer-model-provider"
                    >
                      {provider}
                    </div>
                    <div role="presentation" className="space-y-0.5">
                      {items.map((m) => {
                        const key = `${m.provider}/${m.modelId}`;
                        const active = value?.provider === m.provider && value?.modelId === m.modelId;
                        const showId = (nameCounts.get(`${m.provider}/${m.displayName}`) ?? 0) > 1;
                        return (
                          <button
                            ref={active ? selectedOptionRef : undefined}
                            type="button"
                            role="option"
                            aria-selected={active}
                            data-menu-option
                            data-testid="composer-model-option"
                            data-model={m.modelId}
                            data-provider={m.provider}
                            tabIndex={active || (!current && key === firstModelKey) ? 0 : -1}
                            title={`${m.provider}/${m.modelId}`}
                            key={key}
                            onClick={() => {
                              onChange({ provider: m.provider, modelId: m.modelId });
                              closeWithTriggerFocus();
                            }}
                            className={`flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors ${
                              active ? "bg-accent-soft text-accent" : "text-text-primary hover:bg-bg-hover"
                            }`}
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13px] leading-5">{m.displayName || m.modelId}</span>
                              {showId && (
                                <span className="mono block truncate text-[10.5px] leading-4 text-text-tertiary">
                                  {m.modelId}
                                </span>
                              )}
                            </span>
                            {active && <Icon name="check" size={14} className="shrink-0" />}
                          </button>
                        );
                      })}
                    </div>
                  </fieldset>
                ))}
              </div>
            </>
          )}

          {view === "levels" && (
            <>
              <MenuHeader title={t("model.thinking")} onBack={() => setView("main")} />
              <div role="listbox" aria-label={t("model.thinking")}>
                {thinkingLevels.map((lv) => {
                  const active = lv === thinkingLevel;
                  return (
                    <button
                      ref={active ? selectedOptionRef : undefined}
                      type="button"
                      role="option"
                      aria-selected={active}
                      data-menu-option
                      tabIndex={
                        active || (!thinkingLevels.includes(thinkingLevel) && lv === thinkingLevels[0]) ? 0 : -1
                      }
                      key={lv}
                      onClick={() => {
                        onThinkingChange(lv);
                        closeWithTriggerFocus();
                      }}
                      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors ${
                        active ? "bg-accent-soft text-accent" : "text-text-primary hover:bg-bg-hover"
                      }`}
                    >
                      <span className="flex-1">{thinkingLevelLabel(lv)}</span>
                      {active && <Icon name="check" size={14} className="shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MenuHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="mb-1 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] text-text-tertiary hover:bg-bg-hover"
    >
      <Icon name="chevronRight" size={12} style={{ transform: "rotate(180deg)" }} />
      {title}
    </button>
  );
}

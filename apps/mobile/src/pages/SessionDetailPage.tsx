/**
 * 会话详情页：与桌面共用的运行时间线、紧凑顶栏、会话设置 Sheet、
 * 悬浮输入框（运行中发送即 steer 插话）与中断按钮。
 */

import { RunActivityTimeline, type RunSegment, thinkingLevelLabel } from "@spcode/ui";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { ModelField } from "../components/ModelPickerSheet";
import { Sheet } from "../components/Sheet";
import { errorText, formatNumber } from "../lib/i18n";
import {
  abortSession,
  ensureSessionOutput,
  loadOlderSessionOutput,
  refreshModels,
  retrySessionOutput,
  sendPrompt,
  setSessionModel,
  setSessionThinkingLevel,
} from "../state/controller";
import { type OutputChunk, useAppStore } from "../state/store";

type OutputItem =
  | { kind: "user"; key: string; chunk: OutputChunk }
  | { kind: "notice"; key: string; chunk: OutputChunk }
  | { kind: "gap"; key: string; chunk: OutputChunk }
  | { kind: "run"; key: string; chunks: OutputChunk[] };

/** 用户/通知/缺口是运行边界；连续助手输出按 PC 规则合成一次运行。 */
function groupOutputChunks(chunks: OutputChunk[]): OutputItem[] {
  const items: OutputItem[] = [];
  let run: OutputChunk[] = [];
  const flush = () => {
    const first = run[0];
    if (first) items.push({ kind: "run", key: `run-${first.id}`, chunks: [...run] });
    run = [];
  };
  for (const chunk of chunks) {
    if (chunk.gap) {
      flush();
      items.push({ kind: "gap", key: `gap-${chunk.id}`, chunk });
    } else if (chunk.kind === "user" || chunk.kind === "notice") {
      flush();
      items.push({ kind: chunk.kind, key: `${chunk.kind}-${chunk.id}`, chunk });
    } else {
      run.push(chunk);
    }
  }
  flush();
  return items;
}

/** 远程输出块 → 双端共享运行段；只有运行中的末尾思考仍处于流式状态。 */
function outputToSegments(chunks: OutputChunk[], active: boolean): RunSegment[] {
  const segments: RunSegment[] = [];
  for (const chunk of chunks) {
    const last = segments[segments.length - 1];
    if (chunk.kind === "thinking") {
      if (last?.kind === "thinking") last.text += chunk.chunk;
      else segments.push({ kind: "thinking", id: `thinking-${chunk.id}`, text: chunk.chunk, done: true });
    } else if (chunk.kind === "text") {
      if (last?.kind === "text") last.text += chunk.chunk;
      else segments.push({ kind: "text", id: `text-${chunk.id}`, text: chunk.chunk });
    } else if (chunk.kind === "tool" && chunk.tool) {
      if (last?.kind === "tools") last.calls.push(chunk.tool);
      else segments.push({ kind: "tools", id: `tools-${chunk.id}`, calls: [chunk.tool] });
    }
  }
  const tail = segments[segments.length - 1];
  if (active && tail?.kind === "thinking") tail.done = false;
  return segments;
}

function OutputView({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("mobile");
  const chunks = useAppStore((s) => s.outputs[sessionId]);
  const session = useAppStore((s) => s.sessions[sessionId]);
  const themeBase = useAppStore((s) => s.themeBase);
  const outputSync = useAppStore((s) => s.outputSync[sessionId]);
  const olderBefore = useAppStore((s) => s.historyCursors[sessionId]);
  const olderLoading = useAppStore((s) => s.olderHistoryLoading[sessionId] === true);
  const connState = useAppStore((s) => s.connState);
  const [olderError, setOlderError] = useState<unknown>(null);
  const prependingRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const [hasNewOutput, setHasNewOutput] = useState(false);
  const items = useMemo(() => groupOutputChunks(chunks ?? []), [chunks]);

  const scrollToBottom = () => {
    stickRef.current = true;
    setAwayFromBottom(false);
    setHasNewOutput(false);
    const bottom = bottomRef.current;
    if (bottom && typeof bottom.scrollIntoView === "function") bottom.scrollIntoView({ block: "end" });
    else if (scrollerRef.current) scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
  };

  // 新输出到达时：停在底部则自动跟随；用户上滑后仅提示，不抢夺滚动位置。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只依赖 chunks；滚动函数与 ref 不需要重建此效果
  useEffect(() => {
    if (prependingRef.current) {
      prependingRef.current = false;
      return;
    }
    if (stickRef.current) scrollToBottom();
    else if (chunks && chunks.length > 0) setHasNewOutput(true);
  }, [chunks]);

  const loadOlder = async () => {
    const scroller = scrollerRef.current;
    const previousHeight = scroller?.scrollHeight ?? 0;
    const previousTop = scroller?.scrollTop ?? 0;
    prependingRef.current = true;
    stickRef.current = false;
    setOlderError(null);
    try {
      await loadOlderSessionOutput(sessionId);
      requestAnimationFrame(() => {
        if (scroller) scroller.scrollTop = previousTop + scroller.scrollHeight - previousHeight;
      });
    } catch (error) {
      prependingRef.current = false;
      setOlderError(error);
    }
  };

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    stickRef.current = atBottom;
    setAwayFromBottom(!atBottom);
    if (atBottom) setHasNewOutput(false);
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        data-testid="session-output-scroller"
        className="thin-scroll h-full overflow-y-auto overscroll-contain px-3 py-2"
      >
        <div className="mx-auto max-w-prose">
          {typeof olderBefore === "number" && (
            <div className="mb-1 text-center">
              <button
                type="button"
                data-testid="history-load-older"
                disabled={olderLoading || connState !== "ready"}
                onClick={() => void loadOlder()}
                className="min-h-11 rounded-lg px-3 text-xs text-accent underline disabled:opacity-40"
              >
                {olderLoading ? t("session.loadingOlder") : t("session.loadOlder")}
              </button>
            </div>
          )}
          {olderError != null && (
            <div role="alert" className="safe-break mb-2 text-xs leading-5 text-danger">
              {errorText(olderError)}
            </div>
          )}
          {outputSync?.status === "error" && (
            <div
              role="alert"
              className="safe-break mb-2 rounded-xl border border-danger/40 bg-danger/8 px-3 py-2 text-xs leading-5 text-danger"
            >
              <div>{errorText(outputSync.error)}</div>
              <button
                type="button"
                data-testid="output-retry"
                disabled={connState !== "ready"}
                onClick={() => void retrySessionOutput(sessionId)}
                className="mt-1 min-h-11 px-1 underline disabled:opacity-40"
              >
                {t("session.retry")}
              </button>
            </div>
          )}
          {!chunks || chunks.length === 0 ? (
            outputSync?.status === "loaded" ? (
              <div className="py-12 text-center text-sm text-text-tertiary">{t("session.emptyOutput")}</div>
            ) : outputSync?.status === "error" ? null : (
              <div role="status" className="py-12 text-center text-sm text-text-tertiary">
                {t("session.loadingOutput")}
              </div>
            )
          ) : (
            <div className="space-y-2">
              {items.map((item, index) => {
                if (item.kind === "gap") {
                  return (
                    <div key={item.key} className="py-1 text-center text-[11px] leading-5 text-text-tertiary">
                      {t("session.gap")}
                    </div>
                  );
                }
                if (item.kind === "user") {
                  return (
                    <div key={item.key} className="flex justify-end" data-testid="mobile-user-message">
                      <div className="safe-break w-fit max-w-[88%] whitespace-pre-wrap rounded-2xl rounded-br-md border border-border bg-user-bubble px-3.5 py-2 text-sm leading-6 text-text-primary">
                        {item.chunk.chunk}
                      </div>
                    </div>
                  );
                }
                if (item.kind === "notice") {
                  return (
                    <div
                      key={item.key}
                      className="safe-break py-1 text-center text-[11px] leading-5 text-text-tertiary"
                    >
                      {item.chunk.chunk}
                    </div>
                  );
                }
                const active =
                  (session?.status === "running" || session?.status === "waiting_permission") &&
                  index === items.length - 1;
                const segments = outputToSegments(item.chunks, active);
                return (
                  <div key={item.key} className="min-w-0 text-text-primary" data-testid="mobile-assistant-run">
                    <RunActivityTimeline
                      segments={segments}
                      active={active}
                      progressSegment={active ? segments[segments.length - 1] : undefined}
                      startedAt={active ? session?.runStartedAt : undefined}
                      themeBase={themeBase}
                    />
                  </div>
                );
              })}
            </div>
          )}
          <div ref={bottomRef} aria-hidden="true" />
        </div>
      </div>
      {awayFromBottom && (
        <button
          type="button"
          data-testid="output-scroll-bottom"
          onClick={scrollToBottom}
          className="absolute bottom-2 left-1/2 min-h-11 -translate-x-1/2 whitespace-nowrap rounded-full border border-border bg-bg-elevated/95 px-4 py-2 text-xs font-medium text-accent shadow-lg shadow-black/10"
        >
          {t(hasNewOutput ? "session.newOutput" : "session.backToBottom")} <span aria-hidden="true">↓</span>
        </button>
      )}
    </div>
  );
}

function TodoBar({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("mobile");
  const todos = useAppStore((s) => s.todos[sessionId]);
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  if (!todos || todos.length === 0) return null;
  const done = todos.filter((todo) => todo.status === "completed").length;
  const active = todos.find((todo) => todo.status === "in_progress");
  return (
    <div className="shrink-0 border-t border-border bg-bg-main px-3">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={listId}
        data-testid="todo-toggle"
        onClick={() => setExpanded((value) => !value)}
        className="min-h-11 w-full py-2 text-left"
      >
        <span className="flex items-center gap-2 text-[11px] text-text-tertiary">
          <span className="shrink-0">
            {t("session.todos", { done: formatNumber(done), total: formatNumber(todos.length) })}
          </span>
          <span className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-bg-active" aria-hidden="true">
            <span
              className="block h-full rounded-full bg-accent transition-all"
              style={{ width: `${(done / todos.length) * 100}%` }}
            />
          </span>
          <span className="min-w-0 flex-1 truncate text-right text-text-tertiary">
            {active ? (active.activeForm ?? active.content) : ""}
          </span>
          <span aria-hidden="true" className={`transition-transform ${expanded ? "rotate-180" : ""}`}>
            ⌄
          </span>
        </span>
      </button>
      {expanded && (
        <ol
          id={listId}
          data-testid="todo-list"
          className="thin-scroll mb-2 max-h-48 space-y-2 overflow-y-auto border-t border-border pt-2"
        >
          {todos.map((todo) => (
            <li key={`${todo.status}-${todo.content}`} className="flex items-start gap-2 text-xs leading-5">
              <span
                aria-hidden="true"
                className={`w-4 shrink-0 text-center ${
                  todo.status === "completed"
                    ? "text-success"
                    : todo.status === "in_progress"
                      ? "text-warning"
                      : "text-text-tertiary"
                }`}
              >
                {todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "▸" : "○"}
              </span>
              <div className="safe-break min-w-0 flex-1">
                <div
                  className={todo.status === "completed" ? "text-text-tertiary line-through" : "text-text-secondary"}
                >
                  {todo.content}
                </div>
                {todo.activeForm && todo.activeForm !== todo.content && (
                  <div className="mt-0.5 text-[11px] leading-4 text-text-tertiary">{todo.activeForm}</div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function SessionSettingsSheet({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { t } = useTranslation("mobile");
  const session = useAppStore((s) => s.sessions[sessionId]);
  const models = useAppStore((s) => s.models);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (models.length === 0) void refreshModels().catch(setError);
  }, [models.length]);
  const model = session?.model
    ? models.find((item) => item.provider === session.model?.provider && item.modelId === session.model?.modelId)
    : undefined;
  const supported = session?.supportedThinkingLevels?.length
    ? session.supportedThinkingLevels
    : (model?.thinkingLevels ?? []);
  const levels =
    supported.length > 0
      ? [...new Set([...supported, ...(session?.thinkingLevel ? [session.thinkingLevel] : [])])]
      : [];

  const update = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={t("session.settings")} description={t("session.settingsHint")} onClose={onClose} busy={busy}>
      <div className="space-y-5">
        <section>
          <h3 className="mb-1.5 text-xs font-medium text-text-tertiary">{t("models.label")}</h3>
          <ModelField
            value={session?.model ?? null}
            inferDefault={false}
            disabled={busy}
            onChange={(next) => {
              if (next) void update(() => setSessionModel(sessionId, next));
            }}
          />
        </section>
        <section>
          <h3 className="mb-1.5 text-xs font-medium text-text-tertiary">{t("session.thinkingLevel")}</h3>
          {levels.length > 0 ? (
            <fieldset className="grid min-w-0 grid-cols-3 gap-2" aria-label={t("session.thinkingLevel")}>
              {levels.map((level) => (
                <button
                  key={level}
                  type="button"
                  data-testid="thinking-level"
                  data-level={level}
                  aria-pressed={session?.thinkingLevel === level}
                  disabled={busy}
                  onClick={() => void update(() => setSessionThinkingLevel(sessionId, level))}
                  className={`min-h-11 rounded-xl border px-2 py-2 text-sm transition-colors disabled:opacity-40 ${
                    session?.thinkingLevel === level
                      ? "border-accent bg-accent-soft font-medium text-accent"
                      : "border-border bg-bg-elevated text-text-secondary active:bg-bg-active"
                  }`}
                >
                  {thinkingLevelLabel(level)}
                </button>
              ))}
            </fieldset>
          ) : (
            <p className="rounded-xl bg-bg-elevated px-3 py-2.5 text-xs leading-5 text-text-tertiary">
              {t("session.thinkingUnsupported")}
            </p>
          )}
        </section>
        {error != null && (
          <div role="alert" className="safe-break text-xs leading-5 text-danger">
            {errorText(error)}
          </div>
        )}
      </div>
    </Sheet>
  );
}

export function SessionDetailPage({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("mobile");
  const session = useAppStore((s) => s.sessions[sessionId]);
  const connState = useAppStore((s) => s.connState);
  const setRoute = useAppStore((s) => s.setRoute);
  const text = useAppStore((s) => s.inputDrafts[sessionId]?.text ?? "");
  const setInputDraft = useAppStore((s) => s.setInputDraft);
  const restoreInputDraft = useAppStore((s) => s.restoreInputDraft);
  const [sending, setSending] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const sendGeneration = useRef(0);
  const sendLocks = useRef(new Set<string>());
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const running = session?.status === "running" || session?.status === "waiting_permission";

  useEffect(() => {
    if (connState === "ready") void ensureSessionOutput(sessionId);
  }, [connState, sessionId]);

  useEffect(() => {
    sessionRef.current = sessionId;
    sendGeneration.current++;
    setSending(false);
    setError(null);
    setShowSettings(false);
    return () => {
      sendGeneration.current++;
    };
  }, [sessionId]);

  const send = async () => {
    const snapshot = text;
    const prompt = snapshot.trim();
    if (!prompt || connState !== "ready" || sendLocks.current.has(sessionId)) return;
    const id = sessionId;
    const generation = ++sendGeneration.current;
    sendLocks.current.add(id);
    setSending(true);
    setError(null);
    const waitingVersion = setInputDraft(id, "");
    try {
      await sendPrompt(id, prompt);
    } catch (err) {
      restoreInputDraft(id, snapshot, waitingVersion);
      if (generation === sendGeneration.current && sessionRef.current === id) setError(err);
    } finally {
      sendLocks.current.delete(id);
      if (generation === sendGeneration.current) setSending(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
        <button
          type="button"
          aria-label={t("common.back")}
          onClick={() => setRoute({ name: "sessions" })}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors active:bg-bg-hover"
        >
          <Icon name="back" size={22} />
        </button>
        <div className="min-w-0 flex-1 py-0.5">
          <div className="truncate text-sm font-semibold leading-5 text-text-primary">
            {session?.title ?? t("sessions.title")}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <div className="min-w-0 flex-1 truncate text-[10px] leading-4 text-text-tertiary" title={session?.cwd}>
              {session?.mode === "project" ? session.cwd : t("common.chatSession")}
            </div>
            {session && (
              <span
                className={`shrink-0 text-[10px] leading-4 ${
                  session.status === "running"
                    ? "text-accent"
                    : session.status === "waiting_permission"
                      ? "text-warning"
                      : "text-text-tertiary"
                }`}
              >
                {t(`status.${session.status}`)}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          data-testid="session-settings"
          onClick={() => setShowSettings(true)}
          aria-label={t("common.settings")}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors active:bg-bg-hover"
        >
          <Icon name="settings" size={20} />
        </button>
      </header>

      <OutputView sessionId={sessionId} />
      <TodoBar sessionId={sessionId} />

      {error != null && (
        <div
          role="alert"
          className="safe-break shrink-0 border-t border-danger/40 bg-danger/8 px-3 py-1.5 text-xs leading-5 text-danger"
        >
          {errorText(error)}
        </div>
      )}

      <div className="shrink-0 bg-bg-root px-2 pt-1 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <div className="mobile-composer flex items-end gap-1 rounded-[26px] border border-border bg-bg-elevated p-1.5">
          <textarea
            data-testid="session-input"
            value={text}
            onChange={(e) => setInputDraft(sessionId, e.target.value)}
            rows={1}
            placeholder={running ? t("session.steerPlaceholder") : t("session.promptPlaceholder")}
            className="mobile-composer-input thin-scroll min-h-11 min-w-0 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-3 py-2.5 text-base leading-6 text-text-primary outline-none placeholder:text-text-tertiary focus:border-0"
          />
          {running && (
            <button
              type="button"
              data-testid="session-abort"
              aria-label={t("session.abort")}
              title={t("session.abort")}
              onClick={() => void abortSession(sessionId).catch((e) => setError(e))}
              disabled={connState !== "ready"}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-danger/10 text-danger transition-colors active:bg-danger/20 disabled:opacity-40"
            >
              <Icon name="stop" size={18} strokeWidth={2} />
            </button>
          )}
          <button
            type="button"
            data-testid="session-send"
            aria-label={sending ? t("session.sending") : t("session.send")}
            aria-busy={sending}
            title={sending ? t("session.sending") : t("session.send")}
            onClick={() => void send()}
            disabled={sending || connState !== "ready" || !text.trim()}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent transition-opacity active:opacity-80 disabled:opacity-30"
          >
            <Icon name="send" size={19} strokeWidth={2.2} />
          </button>
        </div>
      </div>

      {showSettings && <SessionSettingsSheet sessionId={sessionId} onClose={() => setShowSettings(false)} />}
    </div>
  );
}

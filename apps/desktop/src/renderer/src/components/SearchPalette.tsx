import type { SessionSearchResultItem } from "@spcode/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatRelative } from "../format";
import { type RegistrySession, useStore } from "../store";
import { Icon } from "./Icon";

interface Row {
  entry: RegistrySession;
  titleMatch: boolean;
  hits: { role: string; snippet: string }[];
}

/**
 * 会话搜索弹窗（Cmd+K / 侧栏搜索按钮）。
 * 标题 + pi 会话正文全文检索；Enter/点击跳转恢复会话，Esc 关闭。
 */
export function SearchPalette({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("chat");
  const { t: tSettings } = useTranslation("settings");
  const registrySessions = useStore((s) => s.registrySessions);
  const sessions = useStore((s) => s.sessions);
  const setActive = useStore((s) => s.setActive);
  const openSession = useStore((s) => s.openSession);

  const [query, setQuery] = useState("");
  const [items, setItems] = useState<SessionSearchResultItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const seq = useRef(0);

  useEffect(() => inputRef.current?.focus(), []);

  // 200ms 防抖搜索；每次查询（包括清空）都递增序号，乱序/失效返回不得覆盖新状态
  useEffect(() => {
    const mySeq = ++seq.current;
    const q = query.trim();
    setSearchError(null);
    if (!q) {
      setItems([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      void window.spcode
        .searchSessions(q)
        .then((r) => {
          if (seq.current === mySeq) setItems(r ?? []);
        })
        .catch((e) => {
          if (seq.current !== mySeq) return;
          setItems([]);
          setSearchError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (seq.current === mySeq) setSearching(false);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  // 关联本地注册表条目（搜索服务只回 id）；已被删除的会话不展示
  const rows = useMemo<Row[]>(() => {
    const byId = new Map(registrySessions.map((r) => [r.id, r]));
    return items.flatMap((it) => {
      const entry = byId.get(it.id);
      return entry ? [{ entry, titleMatch: it.titleMatch, hits: it.hits }] : [];
    });
  }, [items, registrySessions]);

  // 查询变化后重置选中项（停留在旧下标会越界/高亮错位——评审 R3-C11）
  // biome-ignore lint/correctness/useExhaustiveDependencies: query 是刻意的触发信号，effect 体内不引用
  useEffect(() => setSelected(0), [query]);
  // 结果集收缩时收拢下标；空结果也保持合法的 0，供后续返回结果时收敛选中项
  useEffect(() => setSelected((i) => clampSelected(i, rows.length)), [rows.length]);
  useEffect(() => {
    if (rows.length === 0) return;
    optionRefs.current[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected, rows.length]);

  const open = (row: Row) => {
    if (sessions[row.entry.id]) setActive(row.entry.id);
    else void openSession(row.entry);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.key === "Enter" || e.key === "Escape") && e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => (rows.length === 0 ? 0 : Math.min(rows.length - 1, i + 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[selected];
      if (row) open(row);
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 遮罩点外关闭，Esc 另有键盘关闭（评审 R3：待统一 Modal 组件化时收敛）
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/55 pt-[14vh] backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("search.placeholder")}
        className="flex max-h-[60vh] w-[640px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-border-strong bg-bg-main shadow-2xl"
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <Icon name="search" size={16} className="shrink-0 text-text-tertiary" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            data-testid="session-search-input"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="session-search-results"
            aria-activedescendant={rows[selected] ? `session-search-option-${selected}` : undefined}
            aria-label={t("search.placeholder")}
            placeholder={t("search.placeholder")}
            className="h-12 min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-text-tertiary"
          />
          {searching && <span className="shrink-0 text-[11px] text-text-tertiary">{t("search.searching")}</span>}
        </div>

        <div
          id="session-search-results"
          role="listbox"
          aria-busy={searching}
          className="min-h-0 flex-1 overflow-y-auto p-1.5"
        >
          {query.trim() && !searching && searchError && (
            <div
              role="alert"
              data-testid="session-search-error"
              className="px-3 py-8 text-center text-[13px] text-danger"
            >
              {tSettings("quota.error", { error: searchError })}
            </div>
          )}
          {query.trim() && !searching && !searchError && rows.length === 0 && (
            <div data-testid="session-search-empty" className="px-3 py-8 text-center text-[13px] text-text-tertiary">
              {t("search.empty")}
            </div>
          )}
          {rows.map((row, i) => (
            <button
              type="button"
              role="option"
              id={`session-search-option-${i}`}
              aria-selected={i === selected}
              ref={(node) => {
                optionRefs.current[i] = node;
              }}
              key={row.entry.id}
              onClick={() => open(row)}
              onMouseEnter={() => setSelected(i)}
              className={`flex w-full items-start gap-2.5 rounded-xl px-3 py-2.5 text-left ${
                i === selected ? "bg-bg-active" : ""
              }`}
            >
              <Icon
                name={row.entry.mode === "project" ? "folder" : "chat"}
                size={15}
                className="mt-0.5 shrink-0 text-text-tertiary"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-text-primary">
                  <Highlight text={row.entry.title} query={query.trim()} />
                </span>
                {row.hits.map((h) => (
                  <span key={h.snippet} className="mt-0.5 block truncate text-[12px] text-text-tertiary">
                    <Highlight text={h.snippet} query={query.trim()} />
                  </span>
                ))}
              </span>
              <span className="shrink-0 pt-0.5 text-[11px] text-text-tertiary">
                {formatRelative(row.entry.updatedAt)}
              </span>
            </button>
          ))}
        </div>

        <div className="border-t border-border px-4 py-2 text-[11px] text-text-tertiary">{t("search.keys")}</div>
      </div>
    </div>
  );
}

/** 空列表没有有效选项，但内部下标始终保持非负，避免结果到达后停在 -1。 */
function clampSelected(index: number, rowCount: number): number {
  return rowCount === 0 ? 0 : Math.min(Math.max(0, index), rowCount - 1);
}

/** 大小写不敏感的关键词高亮 */
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  for (;;) {
    const idx = lower.indexOf(q, i);
    if (idx < 0) {
      parts.push(text.slice(i));
      break;
    }
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(
      <mark key={idx} className="bg-accent/25 text-accent">
        {text.slice(idx, idx + q.length)}
      </mark>,
    );
    i = idx + q.length;
  }
  return <>{parts}</>;
}

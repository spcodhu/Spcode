import type { SessionSearchResultItem } from "@spcode/shared";
import { useEffect, useMemo, useRef, useState } from "react";
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
  const registrySessions = useStore((s) => s.registrySessions);
  const sessions = useStore((s) => s.sessions);
  const setActive = useStore((s) => s.setActive);
  const openSession = useStore((s) => s.openSession);

  const [query, setQuery] = useState("");
  const [items, setItems] = useState<SessionSearchResultItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  useEffect(() => inputRef.current?.focus(), []);

  // 200ms 防抖搜索；乱序返回只认最后一发
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setItems([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const mySeq = ++seq.current;
    const timer = setTimeout(() => {
      void window.spcode
        .searchSessions(q)
        .then((r) => {
          if (seq.current === mySeq) setItems(r ?? []);
        })
        .catch(() => {})
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

  useEffect(() => setSelected(0), []);

  const open = (row: Row) => {
    if (sessions[row.entry.id]) setActive(row.entry.id);
    else void openSession(row.entry);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => Math.min(rows.length - 1, i + 1));
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
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/55 pt-[14vh] backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[60vh] w-[640px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-border-strong bg-bg-main shadow-2xl">
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <Icon name="search" size={16} className="shrink-0 text-text-tertiary" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索会话标题与正文…"
            className="h-12 min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-text-tertiary"
          />
          {searching && <span className="shrink-0 text-[11px] text-text-tertiary">搜索中…</span>}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {query.trim() && !searching && rows.length === 0 && (
            <div className="px-3 py-8 text-center text-[13px] text-text-tertiary">没有匹配的会话</div>
          )}
          {rows.map((row, i) => (
            <button
              type="button"
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

        <div className="border-t border-border px-4 py-2 text-[11px] text-text-tertiary">
          ↑↓ 选择 · Enter 打开 · Esc 关闭
        </div>
      </div>
    </div>
  );
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

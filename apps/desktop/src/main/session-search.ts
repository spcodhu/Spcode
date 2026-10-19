/**
 * 会话全文搜索：注册表标题 + pi 会话 JSONL 正文。
 *
 * 主进程本地检索：标题命中走快路径；正文逐行解析 JSONL，
 * 抽 user/assistant 文本块做大小写不敏感匹配，截取命中处上下文摘要。
 * 结果只带会话 id，渲染进程按 id 关联本地注册表条目后展示/跳转。
 */
import { readFile, stat } from "node:fs/promises";
import type { SessionSearchHit, SessionSearchResultItem } from "@spcode/shared";
import type { SessionRegistryEntry } from "./session-registry.js";

/** 单个会话文件超过该体积直接跳过（全文检索不读巨型文件） */
const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** 总会话结果上限 */
const MAX_RESULTS = 50;
/** 每个会话最多带几条正文命中 */
const MAX_HITS_PER_SESSION = 3;
/** 摘要上下文字符半径 */
const SNIPPET_RADIUS = 40;

export async function searchSessions(
  entries: SessionRegistryEntry[],
  query: string,
): Promise<SessionSearchResultItem[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results: SessionSearchResultItem[] = [];
  for (const entry of entries) {
    const titleMatch = entry.title.toLowerCase().includes(q);
    const hits = entry.sessionFile ? await searchSessionFile(entry.sessionFile, q) : [];
    if (titleMatch || hits.length > 0) results.push({ id: entry.id, titleMatch, hits });
  }
  // 标题命中优先，其余保持注册表传入顺序（已按更新时间倒序）。
  // 评审 R3-C15：先排序后截断——原实现截断在排序前，标题命中可能被挤出结果集
  results.sort((a, b) => Number(b.titleMatch) - Number(a.titleMatch));
  return results.slice(0, MAX_RESULTS);
}

async function searchSessionFile(file: string, q: string): Promise<SessionSearchHit[]> {
  try {
    const st = await stat(file);
    if (st.size > MAX_FILE_BYTES) return [];
    const raw = await readFile(file, "utf-8");
    return findHitsInLines(raw.split("\n"), q);
  } catch {
    return [];
  }
}

/**
 * 纯函数核心：从 pi 会话 JSONL 行序列提取命中摘要（每条消息最多一个命中）。导出供单测。
 */
export function findHitsInLines(
  lines: string[],
  queryLower: string,
  maxHits = MAX_HITS_PER_SESSION,
): SessionSearchHit[] {
  const hits: SessionSearchHit[] = [];
  for (const line of lines) {
    if (hits.length >= maxHits) break;
    if (!line.toLowerCase().includes(queryLower)) continue;
    let obj: { type?: string; timestamp?: string; message?: { role?: string; content?: unknown } };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== "message" || !obj.message) continue;
    const { role, content } = obj.message;
    if (role !== "user" && role !== "assistant") continue;
    if (!Array.isArray(content)) continue;
    for (const block of content as { type?: string; text?: string }[]) {
      if (block.type !== "text" || !block.text) continue;
      const flat = block.text.replace(/\s+/g, " ").trim();
      const idx = flat.toLowerCase().indexOf(queryLower);
      if (idx < 0) continue;
      const start = Math.max(0, idx - SNIPPET_RADIUS);
      const end = Math.min(flat.length, idx + queryLower.length + SNIPPET_RADIUS);
      hits.push({
        role,
        timestamp: Date.parse(obj.timestamp ?? "") || 0,
        snippet: `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`,
      });
      break;
    }
  }
  return hits;
}

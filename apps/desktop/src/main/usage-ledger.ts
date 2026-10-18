/**
 * 用量账本：UsageRecord 逐条追加到 ~/.spcode/usage/YYYY-MM-DD.jsonl，
 * 支持按日/按模型聚合查询。纯 JSONL 本地优先，无原生依赖。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { UsageAggregate, UsageRecord } from "@spcode/shared";
import { resolveSpcodeHome } from "@spcode/shared/node";

export interface DailyUsage {
  date: string;
  total: UsageAggregate;
  byModel: Record<string, UsageAggregate>;
}

export class UsageLedger {
  private readonly dir: string;

  constructor(baseDir?: string) {
    this.dir = join(baseDir ?? resolveSpcodeHome(), "usage");
    mkdirSync(this.dir, { recursive: true });
  }

  private fileFor(date: string): string {
    return join(this.dir, `${date}.jsonl`);
  }

  static dateOf(ts: number): string {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  append(record: UsageRecord): void {
    const line = JSON.stringify({ ...record, date: UsageLedger.dateOf(record.timestamp) });
    appendFileSync(this.fileFor(UsageLedger.dateOf(record.timestamp)), `${line}\n`, "utf-8");
  }

  private readDay(date: string): UsageRecord[] {
    const file = this.fileFor(date);
    if (!existsSync(file)) return [];
    const out: UsageRecord[] = [];
    for (const line of readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as UsageRecord);
      } catch {
        // 跳过坏行
      }
    }
    return out;
  }

  listDates(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.replace(".jsonl", ""))
      .sort()
      .reverse();
  }

  /** 近 N 个自然日的起始日期（YYYY-MM-DD，含今天；零填充字符串可直接比较大小） */
  static daysAgo(n: number): string {
    const d = new Date();
    d.setDate(d.getDate() - (n - 1));
    return UsageLedger.dateOf(d.getTime());
  }

  /** 最近 N 个活跃日的聚合（趋势曲线/热点图用：只列有记录的日子） */
  summarize(days = 14): DailyUsage[] {
    return this.listDates()
      .slice(0, days)
      .map((date) => {
        const records = this.readDay(date);
        const total = emptyAgg();
        const byModel: Record<string, UsageAggregate> = {};
        for (const r of records) {
          foldInto(total, r);
          foldByModel(byModel, r);
        }
        return { date, total, byModel };
      });
  }

  /** 指定厂商近 N 个自然日的本地用量（配额页兜底展示：无在线查询接口的厂商用） */
  providerUsage(providerId: string, days = 7): { tokens: number; requests: number } | null {
    const cutoff = UsageLedger.daysAgo(days);
    let tokens = 0;
    let requests = 0;
    for (const date of this.listDates()) {
      if (date < cutoff) continue;
      for (const r of this.readDay(date)) {
        if (r.model.provider !== providerId) continue;
        tokens += r.input + r.output + r.cacheRead + r.cacheWrite;
        requests += 1;
      }
    }
    return requests > 0 ? { tokens, requests } : null;
  }

  /** 区间聚合：today=今天，week=近 7 个自然日，all=全部。用量页 Dashboard 用。
   *  注意 week 是自然日窗口而非「最近 7 个活跃日」——后者在活跃日总数 ≤7 时与累计完全相同。 */
  aggregateRange(range: "today" | "week" | "all"): { total: UsageAggregate; byModel: Record<string, UsageAggregate> } {
    const dates = this.listDates();
    const today = UsageLedger.dateOf(Date.now());
    const weekStart = UsageLedger.daysAgo(7);
    const picked =
      range === "today"
        ? dates.filter((d) => d === today)
        : range === "week"
          ? dates.filter((d) => d >= weekStart)
          : dates;
    const total = emptyAgg();
    const byModel: Record<string, UsageAggregate> = {};
    for (const date of picked) {
      for (const r of this.readDay(date)) {
        foldInto(total, r);
        foldByModel(byModel, r);
      }
    }
    return { total, byModel };
  }
}

export function emptyAgg(): UsageAggregate {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costInput: 0,
    costOutput: 0,
    costCacheRead: 0,
    costCacheWrite: 0,
    costTotal: 0,
    count: 0,
  };
}

function foldInto(agg: UsageAggregate, r: UsageRecord): void {
  agg.input += r.input;
  agg.output += r.output;
  agg.cacheRead += r.cacheRead;
  agg.cacheWrite += r.cacheWrite;
  agg.costInput += r.costInput;
  agg.costOutput += r.costOutput;
  agg.costCacheRead += r.costCacheRead;
  agg.costCacheWrite += r.costCacheWrite;
  agg.costTotal += r.costTotal;
  agg.count += 1;
}

/** 按 provider/modelId 分桶聚合（get-or-create 后折叠） */
function foldByModel(byModel: Record<string, UsageAggregate>, r: UsageRecord): void {
  const key = `${r.model.provider}/${r.model.modelId}`;
  let agg = byModel[key];
  if (!agg) {
    agg = emptyAgg();
    byModel[key] = agg;
  }
  foldInto(agg, r);
}

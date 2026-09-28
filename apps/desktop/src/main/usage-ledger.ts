/**
 * 用量账本：UsageRecord 逐条追加到 ~/.spcode/usage/YYYY-MM-DD.jsonl，
 * 支持按日/按模型聚合查询。纯 JSONL 本地优先，无原生依赖。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SPCODE_HOME_DIRNAME, type UsageAggregate, type UsageRecord } from "@spcode/shared";

export interface DailyUsage {
  date: string;
  total: UsageAggregate;
  byModel: Record<string, UsageAggregate>;
}

export class UsageLedger {
  private readonly dir: string;

  constructor(baseDir?: string) {
    this.dir = join(baseDir ?? join(homedir(), SPCODE_HOME_DIRNAME), "usage");
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
    appendFileSync(this.fileFor(UsageLedger.dateOf(record.timestamp)), line + "\n", "utf-8");
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

  /** 最近 N 天的聚合（含当天） */
  summarize(days = 14): DailyUsage[] {
    return this.listDates()
      .slice(0, days)
      .map((date) => {
        const records = this.readDay(date);
        const total = emptyAgg();
        const byModel: Record<string, UsageAggregate> = {};
        for (const r of records) {
          foldInto(total, r);
          const key = `${r.model.provider}/${r.model.modelId}`;
          foldInto((byModel[key] ??= emptyAgg()), r);
        }
        return { date, total, byModel };
      });
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

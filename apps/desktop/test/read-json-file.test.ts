/**
 * readJsonFile（评审 P2-4）：坏文件不再静默吞掉——
 * 解析失败/校验不通过时先备份 .corrupt-<ts>，再返回 null 由调用方重建。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonFile } from "@spcode/shared/node";
import { describe, expect, it } from "vitest";

const asStrings = (data: unknown): string[] | null =>
  Array.isArray(data) && data.every((x) => typeof x === "string") ? (data as string[]) : null;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "spcode-readjson-"));
}

describe("readJsonFile", () => {
  it("文件不存在返回 null（首跑常态，不产生备份）", () => {
    const dir = tempDir();
    expect(readJsonFile(join(dir, "none.json"), asStrings)).toBeNull();
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("合法数据校验通过后原样返回", () => {
    const dir = tempDir();
    const file = join(dir, "ok.json");
    writeFileSync(file, JSON.stringify(["a", "b"]), "utf-8");
    expect(readJsonFile(file, asStrings)).toEqual(["a", "b"]);
    expect(readdirSync(dir)).toEqual(["ok.json"]);
  });

  it("JSON 解析失败：备份 .corrupt 并返回 null", () => {
    const dir = tempDir();
    const file = join(dir, "broken.json");
    writeFileSync(file, "{not json", "utf-8");
    expect(readJsonFile(file, asStrings)).toBeNull();
    const backups = readdirSync(dir).filter((f) => f.startsWith("broken.json.corrupt-"));
    expect(backups).toHaveLength(1);
    // 备份保留原始内容，可人工恢复
    expect(readFileSync(join(dir, backups[0]!), "utf-8")).toBe("{not json");
  });

  it("校验不通过：同样备份并返回 null", () => {
    const dir = tempDir();
    const file = join(dir, "wrong.json");
    writeFileSync(file, JSON.stringify([1, 2, 3]), "utf-8");
    expect(readJsonFile(file, asStrings)).toBeNull();
    expect(readdirSync(dir).some((f) => f.startsWith("wrong.json.corrupt-"))).toBe(true);
  });

  it("合法文件反复读不产生备份", () => {
    const dir = tempDir();
    const file = join(dir, "ok.json");
    writeFileSync(file, JSON.stringify(["x"]), "utf-8");
    readJsonFile(file, asStrings);
    readJsonFile(file, asStrings);
    expect(readdirSync(dir)).toEqual(["ok.json"]);
    expect(existsSync(file)).toBe(true);
  });
});

import { normalizeReleaseNotes, resolveAllowPrerelease } from "@spcode/shared";
import { describe, expect, it } from "vitest";

/**
 * 更新通道裁决（设置页「接收测试版更新」开关的语义）：
 * 显式设置优先；未设置时跟随当前版本形态（beta 版收 beta，稳定版只收稳定）。
 */
describe("resolveAllowPrerelease 更新通道裁决", () => {
  it("显式设置优先于版本形态", () => {
    expect(resolveAllowPrerelease(true, "0.1.0")).toBe(true); // 稳定版用户主动收 beta
    expect(resolveAllowPrerelease(false, "0.1.0-beta.4")).toBe(false); // beta 用户钉稳定通道
  });

  it("未设置时跟随当前版本形态", () => {
    expect(resolveAllowPrerelease(undefined, "0.1.0-beta.4")).toBe(true);
    expect(resolveAllowPrerelease(null, "0.1.0-alpha.1")).toBe(true);
    expect(resolveAllowPrerelease(undefined, "0.1.0")).toBe(false);
  });

  it("版本号边界：v 前缀与构建元数据不影响判定", () => {
    expect(resolveAllowPrerelease(undefined, "v0.1.0-beta.4")).toBe(true);
    expect(resolveAllowPrerelease(undefined, "0.1.0+build.7")).toBe(false);
    expect(resolveAllowPrerelease(undefined, "1.2.3-rc.1+sha.abc")).toBe(true);
  });
});

describe("normalizeReleaseNotes 发布说明归一", () => {
  it("字符串原样返回（去首尾空白）", () => {
    expect(normalizeReleaseNotes("  ## What's Changed\n- fix A  ")).toBe("## What's Changed\n- fix A");
  });

  it("数组形态拼接各版本 note，跳过空项", () => {
    expect(
      normalizeReleaseNotes([
        { version: "0.1.0-beta.9", note: "- fix A" },
        { version: "0.1.0-beta.8", note: null },
        { version: "0.1.0-beta.7", note: "- fix B" },
      ]),
    ).toBe("- fix A\n\n- fix B");
  });

  it("空值归一为空串（UI 显示兜底文案）", () => {
    expect(normalizeReleaseNotes(null)).toBe("");
    expect(normalizeReleaseNotes(undefined)).toBe("");
    expect(normalizeReleaseNotes([])).toBe("");
  });
});

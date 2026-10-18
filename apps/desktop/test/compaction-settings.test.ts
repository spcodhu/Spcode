/**
 * 压缩设置链路保障测试：锁定 Spcod 依赖的 pi 引擎行为假设——
 * SettingsManager.inMemory + applyOverrides 后，getCompactionSettings 实时读到新值
 * （引擎每轮压缩判断都实时调它，所以设置变更对活跃会话即时生效）。
 * pi 升级若改变该行为（缓存快照/延迟合并等），这里会红。
 */
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_COMPACTION_SETTINGS, sanitizeCompactionSettings } from "@spcode/shared";
import { describe, expect, it } from "vitest";

describe("pi SettingsManager 压缩设置链路", () => {
  it("inMemory 初始值即生效，applyOverrides 实时改变读取结果", () => {
    const sm = SettingsManager.inMemory({ compaction: { ...DEFAULT_COMPACTION_SETTINGS } });
    expect(sm.getCompactionSettings(undefined)).toEqual({
      enabled: true,
      reserveTokens: 16384,
      keepRecentTokens: 40000,
    });

    sm.applyOverrides({ compaction: { enabled: false, reserveTokens: 32768, keepRecentTokens: 80000 } });
    expect(sm.getCompactionSettings(undefined)).toEqual({
      enabled: false,
      reserveTokens: 32768,
      keepRecentTokens: 80000,
    });
  });

  it("未下发任何设置时回落 pi 引擎内建默认（enabled/16384/20000）", () => {
    const sm = SettingsManager.inMemory();
    expect(sm.getCompactionSettings(undefined)).toEqual({
      enabled: true,
      reserveTokens: 16384,
      keepRecentTokens: 20000,
    });
  });
});

describe("sanitizeCompactionSettings", () => {
  it("非法字段回落出厂默认（pi 读到非法值会在 agent 循环里 throw）", () => {
    expect(sanitizeCompactionSettings({ enabled: "yes", reserveTokens: -5, keepRecentTokens: 1.5 })).toEqual(
      DEFAULT_COMPACTION_SETTINGS,
    );
    expect(sanitizeCompactionSettings(null)).toEqual(DEFAULT_COMPACTION_SETTINGS);
    expect(sanitizeCompactionSettings({ reserveTokens: 32768 })).toEqual({
      ...DEFAULT_COMPACTION_SETTINGS,
      reserveTokens: 32768,
    });
  });
});

/**
 * 模型目录联网刷新功能测试：
 * - DEFAULT_SETTINGS 包含 modelCatalogAutoSync: true
 * - sanitizeAppSettings 对 modelCatalogAutoSync 的布尔校验
 * - ModelCatalogSyncStatus 类型字段完整性
 */
import { DEFAULT_SETTINGS, type ModelCatalogSyncStatus } from "@spcode/shared";
import { describe, expect, it } from "vitest";
import { sanitizeAppSettings } from "../src/main/settings-store.js";

describe("模型目录自动同步设置", () => {
  it("DEFAULT_SETTINGS 默认开启 modelCatalogAutoSync", () => {
    expect(DEFAULT_SETTINGS.modelCatalogAutoSync).toBe(true);
  });

  it("sanitizeAppSettings 保留合法布尔值", () => {
    expect(sanitizeAppSettings({ modelCatalogAutoSync: true }).modelCatalogAutoSync).toBe(true);
    expect(sanitizeAppSettings({ modelCatalogAutoSync: false }).modelCatalogAutoSync).toBe(false);
  });

  it("sanitizeAppSettings 剔除非布尔值（回落默认）", () => {
    expect(sanitizeAppSettings({ modelCatalogAutoSync: "yes" as unknown as boolean }).modelCatalogAutoSync).toBe(
      undefined,
    );
    expect(sanitizeAppSettings({ modelCatalogAutoSync: 1 as unknown as boolean }).modelCatalogAutoSync).toBe(undefined);
    expect(sanitizeAppSettings({ modelCatalogAutoSync: null as unknown as boolean }).modelCatalogAutoSync).toBe(
      undefined,
    );
  });
});

describe("ModelCatalogSyncStatus 类型", () => {
  it("字段结构正确", () => {
    const status: ModelCatalogSyncStatus = {
      lastSyncedAt: Date.now(),
      lastError: null,
      inProgress: false,
    };
    expect(status.lastSyncedAt).toBeTypeOf("number");
    expect(status.lastError).toBeNull();
    expect(status.inProgress).toBe(false);
  });

  it("允许 null 时间戳与错误信息", () => {
    const status: ModelCatalogSyncStatus = {
      lastSyncedAt: null,
      lastError: "network timeout",
      inProgress: true,
    };
    expect(status.lastSyncedAt).toBeNull();
    expect(status.lastError).toBe("network timeout");
    expect(status.inProgress).toBe(true);
  });
});

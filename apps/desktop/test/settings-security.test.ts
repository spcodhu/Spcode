/**
 * 设置安全加固单测（评审 R3-C8）：
 * - sanitizeAppSettings：fail-safe（非法 permissionMode 剔除回落 ask，绝不让 write 全放行）
 * - settings.json 0600 落盘 + 存量 0644 文件启动收紧
 * - 渲染层脱敏/掩码还原的完整往返
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, SECRET_MASK } from "@spcode/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  redactSettingsForRenderer,
  restoreMaskedSecrets,
  SettingsStore,
  sanitizeAppSettings,
} from "../src/main/settings-store.js";

let dir = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "spcode-settings-sec-"));
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("sanitizeAppSettings（fail-safe）", () => {
  it("非法 permissionMode 被剔除（合并后回落默认 ask）", () => {
    const out = sanitizeAppSettings({ permissionMode: "yolo" as never });
    expect(out.permissionMode).toBeUndefined();
    // 与默认值合并后是 ask——write 级操作回到弹窗
    expect({ ...DEFAULT_SETTINGS, ...out }.permissionMode).toBe("ask");
  });

  it("类型不符的布尔/字符串/数组字段剔除；permissionRules 滤掉非字符串", () => {
    const out = sanitizeAppSettings({
      memoryDistill: "yes" as never,
      autoUpdate: 1 as never,
      permissionRules: ["git push", 42, null, "pnpm test"] as never,
      disabledProviders: "openai" as never,
    });
    expect(out.memoryDistill).toBeUndefined();
    expect(out.autoUpdate).toBeUndefined();
    expect(out.permissionRules).toEqual(["git push", "pnpm test"]);
    expect(out.disabledProviders).toBeUndefined();
  });

  it("嵌套对象是数组/标量时剔除（交给默认归一化）", () => {
    const out = sanitizeAppSettings({ sandbox: [] as never, remote: "x" as never });
    expect(out.sandbox).toBeUndefined();
    expect(out.remote).toBeUndefined();
  });
});

describe("settings.json 权限", () => {
  it("写入即 0600；存量 0644 文件构造时收紧", () => {
    if (process.platform === "win32") return;
    const store = new SettingsStore(dir);
    store.set({ permissionMode: "act" });
    expect(statSync(store.dir + "/settings.json").mode & 0o777).toBe(0o600);

    // 模拟存量 0644 文件 → 新实例构造即收紧
    const dir2 = join(dir, "legacy");
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir2, "settings.json"), "{}", { mode: 0o644 });
    expect(statSync(join(dir2, "settings.json")).mode & 0o777).toBe(0o644);
    new SettingsStore(dir2);
    expect(statSync(join(dir2, "settings.json")).mode & 0o777).toBe(0o600);
  });
});

describe("密钥脱敏与掩码还原", () => {
  it("getSettings 脱敏：apiKey/appSecret 只回掩码；未配置回空串", () => {
    const store = new SettingsStore(dir);
    store.set({
      advancedSearch: { protocol: "tavily", baseUrl: "https://api.tavily.com/search", apiKey: "real-key-123" },
      remote: { ...DEFAULT_SETTINGS.remote, feishu: { enabled: true, appId: "cli_x", appSecret: "real-secret-456" } },
    });
    const redacted = redactSettingsForRenderer(store.get());
    expect(redacted.advancedSearch?.apiKey).toBe(SECRET_MASK);
    expect(redacted.remote.feishu.appSecret).toBe(SECRET_MASK);
    // 磁盘上的真值不受影响
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8")).advancedSearch.apiKey).toBe("real-key-123");
  });

  it("掩码写回 → 还原真值；显式新值/清空 → 生效", () => {
    const store = new SettingsStore(dir);
    const current = store.get();

    // 1. 掩码写回（用户没动密钥，只改了别的）→ 真值保留
    const patch1 = restoreMaskedSecrets(
      {
        advancedSearch: { protocol: "bocha", baseUrl: "https://api.bochaai.com/v1/web-search", apiKey: SECRET_MASK },
        remote: { ...current.remote, feishu: { enabled: true, appId: "cli_x", appSecret: SECRET_MASK } },
      },
      current,
    );
    expect(patch1.advancedSearch?.apiKey).toBe("real-key-123");
    expect(patch1.remote?.feishu?.appSecret).toBe("real-secret-456");

    // 2. 显式新值 → 生效
    const patch2 = restoreMaskedSecrets(
      { advancedSearch: { protocol: "tavily", baseUrl: "https://api.tavily.com/search", apiKey: "new-key" } },
      current,
    );
    expect(patch2.advancedSearch?.apiKey).toBe("new-key");

    // 3. 清空（空串）→ 生效为空
    const patch3 = restoreMaskedSecrets(
      { advancedSearch: { protocol: "tavily", baseUrl: "https://api.tavily.com/search", apiKey: "" } },
      current,
    );
    expect(patch3.advancedSearch?.apiKey).toBe("");
  });
});

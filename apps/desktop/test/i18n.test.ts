import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createI18n,
  getLocale,
  i18n,
  interpolationNames,
  isDefaultSessionTitle,
  localizeDefaultTitle,
  resolveLocale,
  setLocale,
  validateProfile,
} from "@spcode/shared/i18n";
import { readBuildProfile } from "@spcode/shared/i18n/build";
import { afterEach, describe, expect, it } from "vitest";
import { resources } from "../../../packages/shared/src/i18n/resources.js";
import { SettingsStore, sanitizeAppSettings } from "../src/main/settings-store.js";

const directories: string[] = [];
afterEach(() => {
  setLocale("zh-CN");
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temporaryHome() {
  const dir = mkdtempSync(join(tmpdir(), "spcode-i18n-"));
  directories.push(dir);
  return dir;
}

describe("bundled language resources", () => {
  it("covers the same logical keys and interpolation parameters", () => {
    for (const [namespace, chinese] of Object.entries(resources["zh-CN"])) {
      const english = resources.en[namespace];
      expect(english, namespace).toBeDefined();
      const logical = (key: string) => key.replace(/_(?:zero|one|two|few|many|other)$/, "");
      expect([...new Set(Object.keys(chinese).map(logical))].sort(), namespace).toEqual(
        [...new Set(Object.keys(english).map(logical))].sort(),
      );
      for (const [key, value] of Object.entries(chinese)) {
        expect(value.trim().length, `${namespace}:${key}`).toBeGreaterThan(0);
        const counterpart = english[key] ?? english[`${logical(key)}_other`];
        expect(counterpart, `${namespace}:${key}`).toBeDefined();
        expect(interpolationNames(value), `${namespace}:${key}`).toBe(interpolationNames(counterpart));
      }
      for (const [key, value] of Object.entries(english)) {
        expect(value, `${namespace}:${key}`).not.toMatch(/[\u4e00-\u9fff]/);
      }
    }
  });

  it("localizes timeline labels and call counts in both locales", () => {
    setLocale("en");
    expect(i18n.t("chat:run.process")).toBe("Execution history");
    expect(i18n.t("chat:run.toolCalls", { count: 1 })).toBe("1 tool call");
    expect(i18n.t("chat:run.toolCalls", { count: 2 })).toBe("2 tool calls");
    expect(i18n.t("chat:run.failedCalls", { count: 1 })).toBe("1 failed");
    expect(i18n.t("chat:run.toolGroup", { tool: "Read file", count: 2 })).toBe("Read file · 2 calls");
    setLocale("zh-CN");
    expect(i18n.t("chat:run.process")).toBe("执行过程");
    expect(i18n.t("chat:run.toolCalls", { count: 2 })).toBe("2 次工具调用");
    expect(i18n.t("chat:run.failedCalls", { count: 1 })).toBe("1 次失败");
    expect(i18n.t("chat:run.toolGroup", { tool: "读取文件", count: 2 })).toBe("读取文件 · 2 次");
  });

  it("keeps custom image protocol placeholders literal in both locales", () => {
    for (const locale of ["zh-CN", "en"]) {
      setLocale(locale);
      expect(i18n.t("settings:skills.imageGen.requestBodyHint")).toContain("{{prompt}}");
      expect(i18n.t("settings:skills.imageGen.requestBodyHint")).toContain("{{model}}");
      expect(i18n.t("settings:skills.imageGen.authHint")).toContain("{{apiKey}}");
      expect(i18n.t("settings:skills.imageGen.bodyError.missingPrompt")).toContain("{{prompt}}");
    }
  });

  it("uses the requested locale and independently initialized instances", () => {
    const first = createI18n();
    const second = createI18n();
    void first.changeLanguage("en");
    expect(first.t("common:newChat")).toBe("New chat");
    expect(second.t("common:newChat")).toBe("新聊天");
    setLocale("en");
    expect(getLocale()).toBe("en");
    expect(i18n.t("common:newProject")).toBe("New project");
  });

  it("validates fixed-language profiles and term overrides", () => {
    const profile = { supportedLocales: ["en"] as const, defaultLocale: "en" as const, fixedLocale: "en" as const };
    expect(resolveLocale("zh-CN", profile)).toBe("en");
    expect(() => validateProfile({ ...profile, defaultLocale: "zh-CN" })).toThrow();
    expect(() => validateProfile({ ...profile, supportedLocales: ["en", "zh-CN"] })).toThrow();
    const customized = createI18n({ ...profile, overrides: { en: { common: { newChat: "New conversation" } } } });
    expect(customized.t("common:newChat")).toBe("New conversation");
    expect(customized.hasResourceBundle("zh-CN", "common")).toBe(false);
    expect(() => createI18n({ ...profile, overrides: { en: { common: { invalidKey: "x" } } } })).toThrow();
    expect(() => createI18n({ ...profile, overrides: { en: { common: { hostExited: "Stopped" } } } })).toThrow();
  });

  it("validates build-time language profiles before bundling", () => {
    const dir = temporaryHome();
    const profile = join(dir, "profile.json");
    writeFileSync(profile, JSON.stringify({ supportedLocales: ["en"], defaultLocale: "en", fixedLocale: "en" }));
    expect(readBuildProfile({ SPCODE_I18N_PROFILE: profile })).toMatchObject({
      defaultLocale: "en",
      fixedLocale: "en",
    });
    writeFileSync(
      profile,
      JSON.stringify({ supportedLocales: ["en", "zh-CN"], defaultLocale: "en", fixedLocale: "en" }),
    );
    expect(() => readBuildProfile({ SPCODE_I18N_PROFILE: profile })).toThrow();
    writeFileSync(
      profile,
      JSON.stringify({ supportedLocales: ["en"], defaultLocale: "en", overrides: { "zh-CN": {} } }),
    );
    expect(() => readBuildProfile({ SPCODE_I18N_PROFILE: profile })).toThrow();
  });
});

describe("locale persistence and default titles", () => {
  it("keeps old settings Chinese and persists an explicit language", () => {
    const dir = temporaryHome();
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ themeId: "spcode-dark" }));
    const settings = new SettingsStore(dir);
    expect(settings.get().locale).toBe("zh-CN");
    settings.set({ locale: "en" });
    expect(new SettingsStore(dir).get().locale).toBe("en");
    expect(sanitizeAppSettings({ locale: "bad" as never }).locale).toBe("zh-CN");
  });

  it("localizes defaults without rewriting explicitly named sessions", () => {
    setLocale("en");
    expect(
      localizeDefaultTitle({ title: "新聊天", cwd: "", mode: "chat" as const, titleKind: "default" as const }).title,
    ).toBe("New chat");
    const userTitle = { title: "新聊天", cwd: "", mode: "chat" as const, titleKind: "custom" as const };
    expect(localizeDefaultTitle(userTitle)).toBe(userTitle);
    expect(isDefaultSessionTitle(userTitle)).toBe(false);
  });
});

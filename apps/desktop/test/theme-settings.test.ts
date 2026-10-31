import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsStore } from "../src/main/settings-store.js";

const dirs: string[] = [];
function homeWith(settings: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "spcode-theme-settings-"));
  dirs.push(dir);
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("内置主题设置迁移", () => {
  it("旧版默认暗色且无自定义主题时一次性迁移到亮色，之后允许显式选暗色", () => {
    const store = new SettingsStore(homeWith({ themeId: "spcode-dark", customTheme: null }));
    expect(store.get().themeId).toBe("spcode-light");
    expect(store.get().themeMigrationVersion).toBe(1);

    store.set({ themeId: "spcode-dark" });
    expect(new SettingsStore(store.dir).get().themeId).toBe("spcode-dark");
  });

  it("已有自定义主题时不被默认色迁移覆盖", () => {
    const customTheme = { name: "我的暗色", base: "dark", colors: { accent: "#123456" } };
    const store = new SettingsStore(homeWith({ themeId: "spcode-dark", customTheme }));
    expect(store.get().themeId).toBe("spcode-dark");
    expect(store.get().customTheme).toEqual(customTheme);
    expect(store.get().themeMigrationVersion).toBe(1);
  });
});

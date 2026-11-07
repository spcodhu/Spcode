/** Windows/macOS 登录项适配：OS 是唯一事实源，设置后立即回读真实状态。 */

import type { AutoLaunchStatus } from "@spcode/shared";
import { i18n } from "@spcode/shared/i18n";
import { app } from "electron";

interface LoginItemSnapshot {
  openAtLogin: boolean;
  status?: "not-registered" | "enabled" | "requires-approval" | "not-found";
  executableWillLaunchAtLogin?: boolean;
}

export interface LoginItemAdapter {
  getLoginItemSettings(): LoginItemSnapshot;
  setLoginItemSettings(settings: { openAtLogin: boolean }): void;
}

export interface LoginItemServiceOptions {
  platform?: NodeJS.Platform;
  packaged?: boolean;
  adapter?: LoginItemAdapter;
}

export class LoginItemService {
  private readonly platform: NodeJS.Platform;
  private readonly isPackaged: () => boolean;
  private readonly adapter: LoginItemAdapter;

  constructor(options: LoginItemServiceOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.isPackaged = options.packaged === undefined ? () => app.isPackaged : () => options.packaged!;
    this.adapter = options.adapter ?? app;
  }

  private availability(): Pick<AutoLaunchStatus, "supported" | "reason"> | null {
    if (this.platform !== "darwin" && this.platform !== "win32") {
      return { supported: false, reason: "unsupported-platform" };
    }
    // 开发模式的 process.execPath 是 Electron 本身，不能把它写进用户登录项。
    if (!this.isPackaged()) return { supported: false, reason: "not-packaged" };
    return null;
  }

  status(): AutoLaunchStatus {
    const unavailable = this.availability();
    if (unavailable) return { ...unavailable, openAtLogin: false };
    try {
      return this.read();
    } catch (error) {
      return {
        supported: true,
        openAtLogin: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  setEnabled(enabled: boolean): AutoLaunchStatus {
    const unavailable = this.availability();
    if (unavailable) throw new Error(i18n.t("main:autoLaunch.unavailable"));
    this.adapter.setLoginItemSettings({ openAtLogin: enabled });
    return this.read();
  }

  private read(): AutoLaunchStatus {
    const snapshot = this.adapter.getLoginItemSettings();
    if (this.platform === "darwin") {
      return {
        supported: true,
        openAtLogin: snapshot.openAtLogin,
        macStatus: snapshot.status ?? (snapshot.openAtLogin ? "enabled" : "not-registered"),
      };
    }
    const effective = snapshot.openAtLogin && (snapshot.executableWillLaunchAtLogin ?? snapshot.openAtLogin);
    return {
      supported: true,
      openAtLogin: effective,
      windowsDeactivated: snapshot.openAtLogin && !effective,
    };
  }
}

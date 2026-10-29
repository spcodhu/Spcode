/**
 * 手机 PWA 资源定位：安装版只认打包 resources，开发版只认 monorepo 的 apps/mobile/dist。
 * 单独抽成纯 Node 模块，避免路径解析依赖 Electron 运行时，便于覆盖打包/开发两种布局。
 */

import { statSync } from "node:fs";
import { join } from "node:path";

export interface MobilePwaRuntime {
  /** Electron app.getAppPath()：开发时通常是 apps/desktop，安装版是 app.asar 路径 */
  appPath: string;
  /** Electron process.resourcesPath */
  resourcesPath: string;
  isPackaged: boolean;
}

/** 仅目录存在还不够：LAN 服务至少需要真实的 index.html 才能托管 PWA。 */
export function isMobilePwaBuilt(dir: string): boolean {
  try {
    return statSync(join(dir, "index.html")).isFile();
  } catch {
    return false;
  }
}

/**
 * env/显式 override 主要用于开发与诊断；普通安装版无需也不应设置它们。
 * 未构建时返回当前布局的预期目录，由 LAN 层渲染对应环境的占位说明。
 */
export function resolveMobileDistDir(override: string | undefined, runtime: MobilePwaRuntime): string {
  const explicit = override?.trim();
  if (explicit) return explicit;
  const fromEnv = process.env.SPCODE_MOBILE_DIST?.trim();
  if (fromEnv) return fromEnv;

  const expected = runtime.isPackaged ? join(runtime.resourcesPath, "mobile") : join(runtime.appPath, "../mobile/dist");
  return expected;
}

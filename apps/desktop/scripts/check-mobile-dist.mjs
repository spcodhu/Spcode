/**
 * 桌面打包前的手机 PWA 完整性门禁。
 * 不只检查 dist 目录：还核对 HTML 实际引用的哈希资源，避免空目录/残缺构建进入安装包。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

function assertFile(path, label = path) {
  try {
    if (statSync(path).isFile()) return;
  } catch {
    // 统一抛出带构建提示的错误
  }
  throw new Error(`手机 PWA 缺少 ${label}；请先运行 pnpm --filter @spcode/mobile build`);
}

export function validateMobileDist(dist) {
  const root = resolve(dist);
  for (const name of ["index.html", "manifest.webmanifest", "sw.js"]) {
    assertFile(resolve(root, name), `apps/mobile/dist/${name}`);
  }

  const html = readFileSync(resolve(root, "index.html"), "utf8");
  const references = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((value) => value?.startsWith("./"));

  if (!references.some((value) => /\.js(?:[?#]|$)/.test(value))) {
    throw new Error("手机 PWA index.html 未引用 JS 入口");
  }
  if (!references.some((value) => /\.css(?:[?#]|$)/.test(value))) {
    throw new Error("手机 PWA index.html 未引用 CSS 入口");
  }

  for (const reference of references) {
    const relative = reference.slice(2).split(/[?#]/, 1)[0];
    const target = resolve(root, relative);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`手机 PWA 引用了 dist 外的资源：${reference}`);
    }
    assertFile(target, `apps/mobile/dist/${relative}`);
  }

  const assets = readdirSync(resolve(root, "assets"));
  if (!assets.some((name) => /^qr-scanner-worker\.min-.+\.js$/.test(name))) {
    throw new Error("手机 PWA 缺少 qr-scanner worker；请重新运行 mobile build");
  }
  return references.length;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const defaultDist = fileURLToPath(new URL("../../mobile/dist/", import.meta.url));
  const count = validateMobileDist(defaultDist);
  console.log(`手机 PWA 校验通过：${defaultDist}（${count} 个 HTML 引用资源）`);
}

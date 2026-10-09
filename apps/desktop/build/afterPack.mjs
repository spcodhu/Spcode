/**
 * electron-builder afterPack 钩子：mac 包 adhoc 重签。
 *
 * 背景：electron-builder.yml 里 identity: null 会让打包器完全跳过签名，
 * bundle 里留着 Electron 出厂的 adhoc 旧签名，但其资源密封已不覆盖
 * 打包时注入的 app.asar 等内容——带隔离属性（浏览器下载）的副本会被
 * Gatekeeper 判「已损坏，无法打开」（beta.5 实机踩坑）。
 *
 * 这里在 afterPack 对整个 .app 重签 adhoc，让密封与内容一致。
 * 挂载点选 afterPack 而非 afterSign：签名被跳过时 afterSign 不会触发
 * （app-builder-lib 源码明示 "skipping afterSign hook as no signing occurred"）。
 * afterPack 之后无 fuse 改写（本项目未配置 electronFuses）、无重签
 * （identity: null 短路），密封保持有效直到 dmg 打包。
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
}

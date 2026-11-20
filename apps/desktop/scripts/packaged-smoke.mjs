/**
 * 打包产物冒烟（tag 前预检，不发布）：
 * 1. 静态校验：ZIP 内 agent-host ESM 与依赖必须 unpacked；latest*.yml 引用的安装包存在。
 * 2. 启动校验：解包后的二进制在隔离 SPCODE_HOME/user-data-dir 下启动并存活，随后终止。
 * 只读真实安装包，绝不触碰用户 ~/.spcode。结果写入 --output 目录的 JSON。
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const releaseDir = join(desktopDir, "release");
const outputArg = process.argv.indexOf("--output");
const outputDir = outputArg >= 0 ? resolve(process.argv[outputArg + 1]) : join(desktopDir, "smoke-output");
mkdirSync(outputDir, { recursive: true });

const report = { platform: process.platform, arch: process.arch, startedAt: new Date().toISOString(), checks: [] };
function check(name, ok, detail) {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

function listZips() {
  if (!existsSync(releaseDir)) return [];
  return readdirSync(releaseDir).filter((f) => f.endsWith(".zip"));
}

function extract(zipPath, dest) {
  mkdirSync(dest, { recursive: true });
  if (process.platform === "win32") {
    execFileSync(
      "powershell",
      ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${dest}' -Force`],
      { stdio: "inherit" },
    );
  } else {
    execFileSync("unzip", ["-q", "-o", zipPath, "-d", dest], { stdio: "inherit" });
  }
}

function findFile(root, predicate, depth = 6) {
  if (depth < 0 || !existsSync(root)) return null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isFile() && predicate(entry.name, full)) return full;
    if (entry.isDirectory()) {
      const found = findFile(full, predicate, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

const zips = listZips();
check("release-zip-present", zips.length > 0, zips.join(", ") || "no zip found");

// latest*.yml 引用的安装包必须存在（与 release.yml 的 publish 校验同口径）
for (const yml of existsSync(releaseDir) ? readdirSync(releaseDir).filter((f) => /^latest.*\.yml$/.test(f)) : []) {
  const text = readFileSync(join(releaseDir, yml), "utf8");
  const refs = [...text.matchAll(/^\s*(?:-\s+)?(?:path|url):\s*(.+?)\s*$/gm)].map((m) =>
    m[1].replace(/^["']|["']$/g, ""),
  );
  const missing = refs.filter((r) => !existsSync(join(releaseDir, decodeURIComponent(r))));
  check(
    `update-metadata:${yml}`,
    refs.length > 0 && missing.length === 0,
    missing.length ? `missing: ${missing.join(", ")}` : `${refs.length} refs`,
  );
}

const workRoot = mkdtempSync(join(tmpdir(), "spcode-packaged-smoke-"));
const spcodeHome = join(workRoot, "home");
const userData = join(workRoot, "userdata");
mkdirSync(spcodeHome, { recursive: true });
mkdirSync(userData, { recursive: true });

let child = null;
try {
  for (const zip of zips) {
    const dest = join(workRoot, zip.replace(/\.zip$/, ""));
    extract(join(releaseDir, zip), dest);
    // agent-host 入口与依赖必须在 app.asar.unpacked（ESM loader 不支持 asar）
    const agentHost = findFile(dest, (name, full) => name === "agent-host.mjs" && full.includes("app.asar.unpacked"));
    check(`unpacked-agent-host:${zip}`, Boolean(agentHost), agentHost ?? "agent-host.mjs not unpacked");
    const unpackedModules = findFile(
      dest,
      (name, full) => name === "pi-coding-agent" && full.includes("app.asar.unpacked"),
    );
    check(`unpacked-pi-deps:${zip}`, Boolean(unpackedModules), unpackedModules ?? "pi-coding-agent not unpacked");

    // 启动二进制：mac 取 .app/Contents/MacOS/*；win 取解包根目录的 exe
    let binary = null;
    if (process.platform === "darwin") {
      binary = findFile(dest, (name, full) => full.includes(".app/Contents/MacOS/") && !name.includes("."));
    } else if (process.platform === "win32") {
      binary = findFile(dest, (name) => name.toLowerCase().endsWith(".exe") && !/uninstall|setup/i.test(name), 3);
    }
    if (!binary) {
      check(`launch:${zip}`, false, "no launchable binary found");
      continue;
    }
    const env = { ...process.env, SPCODE_HOME: spcodeHome, SPCODE_E2E_BACKGROUND: "1" };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(binary, ["--no-sandbox", `--user-data-dir=${userData}`], { env, stdio: "ignore" });
    const alive = await new Promise((resolvePromise) => {
      const timer = setTimeout(() => resolvePromise(true), 8000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolvePromise(false);
        report.checks.push({ name: `launch-exit:${zip}`, ok: false, detail: `exited early code=${code}` });
      });
    });
    check(`launch-alive-8s:${zip}`, alive, binary);
    if (child && !child.killed) {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 1500));
      if (!child.killed) child.kill("SIGKILL");
    }
    child = null;
    // 只测第一个 ZIP（同平台架构一致），避免重复启动
    break;
  }
} finally {
  if (child && !child.killed) child.kill("SIGKILL");
  rmSync(workRoot, { recursive: true, force: true });
}

report.finishedAt = new Date().toISOString();
writeFileSync(join(outputDir, "packaged-smoke.json"), JSON.stringify(report, null, 2));
console.log(`report: ${join(outputDir, "packaged-smoke.json")}`);

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeJsonFileAtomic } from "@spcode/shared/node";

export interface ControlRuntimeInfo {
  protocolVersion: 1;
  pid: number;
  port: number;
  serviceToken: string;
  startedAt: number;
}

export function runtimeFile(baseDir: string): string {
  return join(baseDir, "runtime.json");
}

export function readRuntimeInfo(baseDir: string): ControlRuntimeInfo | null {
  const file = runtimeFile(baseDir);
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<ControlRuntimeInfo>;
    if (
      value.protocolVersion !== 1 ||
      !Number.isSafeInteger(value.pid) ||
      !Number.isSafeInteger(value.port) ||
      (value.port ?? 0) <= 0 ||
      typeof value.serviceToken !== "string" ||
      !value.serviceToken ||
      typeof value.startedAt !== "number"
    ) {
      return null;
    }
    return value as ControlRuntimeInfo;
  } catch {
    return null;
  }
}

export function writeRuntimeInfo(baseDir: string, port: number, startedAt: number): ControlRuntimeInfo {
  const info: ControlRuntimeInfo = {
    protocolVersion: 1,
    pid: process.pid,
    port,
    serviceToken: randomBytes(32).toString("base64url"),
    startedAt,
  };
  writeJsonFileAtomic(runtimeFile(baseDir), info, { mode: 0o600 });
  return info;
}

export function removeRuntimeInfo(baseDir: string): void {
  try {
    const info = readRuntimeInfo(baseDir);
    if (info?.pid === process.pid) rmSync(runtimeFile(baseDir), { force: true });
  } catch {
    // 关机清理失败不影响已提交事实。
  }
}

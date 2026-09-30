/**
 * resolveSpcodeHome（评审 P1-7）：
 * - 缺省落在 ~/.spcode（与 shared 主入口的 SPCODE_HOME_DIRNAME 一致）
 * - SPCODE_HOME 环境变量可覆盖（e2e/测试隔离的依赖点）
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SPCODE_HOME_DIRNAME } from "@spcode/shared";
import { resolveSpcodeHome } from "@spcode/shared/node";

describe("resolveSpcodeHome", () => {
  const original = process.env.SPCODE_HOME;
  afterEach(() => {
    if (original === undefined) delete process.env.SPCODE_HOME;
    else process.env.SPCODE_HOME = original;
  });

  it("缺省为 ~/.spcode（目录名与主入口常量一致）", () => {
    delete process.env.SPCODE_HOME;
    expect(resolveSpcodeHome()).toBe(join(homedir(), SPCODE_HOME_DIRNAME));
  });

  it("SPCODE_HOME 环境变量覆盖", () => {
    process.env.SPCODE_HOME = "/tmp/spcode-custom";
    expect(resolveSpcodeHome()).toBe("/tmp/spcode-custom");
  });

  it("空白环境变量视为未设置", () => {
    process.env.SPCODE_HOME = "   ";
    expect(resolveSpcodeHome()).toBe(join(homedir(), SPCODE_HOME_DIRNAME));
  });
});

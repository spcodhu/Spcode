/**
 * 权限裁决矩阵纯函数单测（shared/permission.ts）。
 *
 * 不变量（改任何一档之前先看这里）：
 * 1. 逃生舱在**三档**都要问 —— 它是唯一会移除内核边界的动作；
 * 2. 逃生舱被设置关闭（strict）时，任何档位任何风险都直接拒；
 * 3. 「总不询问」放行一切（含 danger/outward），但只读/写/危险的判定不能被它反过来改变；
 * 4. 「必要时询问」只自动放行 write，outward/danger 仍然问。
 */

import {
  BYPASS_DISABLED_REASON,
  DEFAULT_PERMISSION_MODE,
  decidePermissionMatrix,
  normalizePermissionMode,
  PERMISSION_MODES,
} from "@spcode/shared";
import { describe, expect, it } from "vitest";

describe("decidePermissionMatrix", () => {
  const risks = ["readonly", "write", "outward", "danger"] as const;

  it("总是询问：只读放行，写/对外/危险一律弹窗", () => {
    expect(decidePermissionMatrix({ risk: "readonly", mode: "ask" }).action).toBe("allow");
    for (const risk of ["write", "outward", "danger"] as const) {
      expect(decidePermissionMatrix({ risk, mode: "ask" }).action, risk).toBe("ask");
    }
  });

  it("必要时询问：write 放行，outward/danger 仍弹窗", () => {
    expect(decidePermissionMatrix({ risk: "write", mode: "auto" }).action).toBe("allow");
    expect(decidePermissionMatrix({ risk: "outward", mode: "auto" }).action).toBe("ask");
    expect(decidePermissionMatrix({ risk: "danger", mode: "auto" }).action).toBe("ask");
  });

  it("总不询问：全部放行", () => {
    for (const risk of risks) {
      expect(decidePermissionMatrix({ risk, mode: "never" }).action, risk).toBe("allow");
    }
  });

  it("逃生舱：三档都弹窗；严格模式任何档位都拒", () => {
    for (const mode of PERMISSION_MODES) {
      expect(decidePermissionMatrix({ risk: "write", mode, bypass: true }).action, mode).toBe("ask");
      const blocked = decidePermissionMatrix({ risk: "write", mode, bypass: true, bypassDisabled: true });
      expect(blocked.action).toBe("block");
      expect(blocked.action === "block" && blocked.reason).toBe(BYPASS_DISABLED_REASON);
      expect(blocked.action === "block" && blocked.reasonKey).toBe("main:permission.sandboxStrict");
    }
  });

  it("沙盒状态不参与判定（模式决定问不问，沙盒决定拦不拦）", () => {
    // 函数签名里没有 sandboxed：这里用类型层面的显式断言锁死，防止有人把它加回来
    const input = { risk: "write" as const, mode: "ask" as const, sandboxed: true } as unknown as Parameters<
      typeof decidePermissionMatrix
    >[0];
    expect(decidePermissionMatrix(input).action).toBe("ask");
  });
});

describe("normalizePermissionMode（旧值迁移）", () => {
  it("act 迁移为 auto，非法值返回 null", () => {
    expect(normalizePermissionMode("act")).toBe("auto");
    expect(normalizePermissionMode("ask")).toBe("ask");
    expect(normalizePermissionMode("auto")).toBe("auto");
    expect(normalizePermissionMode("never")).toBe("never");
    expect(normalizePermissionMode("yolo")).toBeNull();
    expect(normalizePermissionMode(undefined)).toBeNull();
    expect(normalizePermissionMode(3)).toBeNull();
  });

  it("默认档位是最保守的一档", () => {
    expect(DEFAULT_PERMISSION_MODE).toBe("ask");
  });
});

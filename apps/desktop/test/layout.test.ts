import { describe, expect, it } from "vitest";
import {
  constrainLayoutWidths,
  DEFAULT_LAYOUT_WIDTHS,
  parseLayoutWidths,
  planRange,
  sidebarRange,
} from "../src/renderer/src/layout.js";

describe("三栏布局宽度", () => {
  it("非法持久化数据回退默认，合法值原样读取", () => {
    expect(parseLayoutWidths(null)).toEqual(DEFAULT_LAYOUT_WIDTHS);
    expect(parseLayoutWidths("not-json")).toEqual(DEFAULT_LAYOUT_WIDTHS);
    expect(parseLayoutWidths('{"sidebar":-1,"plan":"wide"}')).toEqual(DEFAULT_LAYOUT_WIDTHS);
    expect(parseLayoutWidths('{"sidebar":280,"plan":640}')).toEqual({ sidebar: 280, plan: 640 });
  });

  it("常规窗口保留用户宽度，计划关闭时不约束其隐藏宽度", () => {
    expect(constrainLayoutWidths({ sidebar: 280, plan: 640 }, 1440, true)).toEqual({ sidebar: 280, plan: 640 });
    expect(constrainLayoutWidths({ sidebar: 280, plan: 640 }, 900, false)).toEqual({ sidebar: 280, plan: 640 });
  });

  it("小窗口依次夹紧侧栏和计划栏，为中间区保留 320px", () => {
    const result = constrainLayoutWidths({ sidebar: 420, plan: 760 }, 900, true);
    expect(result).toEqual({ sidebar: 244, plan: 320 });
    expect(900 - result.sidebar - result.plan - 16).toBe(320);
  });

  it("手柄键盘范围与当前可用宽度一致", () => {
    expect(sidebarRange(900, 364, true)).toEqual([200, 200]);
    expect(planRange(1440, 248)).toEqual([320, 760]);
  });
});

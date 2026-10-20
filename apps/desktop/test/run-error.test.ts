/**
 * 运行错误分类单测：额度/鉴权/限流/超长/网络/未知。
 * 这些文案会直接出现在错误卡标题与系统通知上，分类错了用户会被指错方向。
 */

import { classifyRunError, classifyRunErrorKind } from "@spcode/shared/run-error";
import { describe, expect, it } from "vitest";

describe("classifyRunError", () => {
  it("额度/账单耗尽（各厂商常见写法）", () => {
    for (const msg of [
      "402 Insufficient Balance",
      "Error: insufficient_quota",
      "quota exceeded for this billing period",
      "You exceeded your current quota, please check your plan and billing details",
      "Monthly usage limit reached: available balance is 0",
      "余额不足，请充值",
      "额度已用尽",
    ]) {
      expect(classifyRunErrorKind(msg)).toBe("quota");
    }
    expect(classifyRunError("402 Insufficient Balance").title).toContain("额度");
    expect(classifyRunError("402 Insufficient Balance").hint).toContain("配额");
  });

  it("鉴权失败", () => {
    for (const msg of ["401 Unauthorized", "invalid api key", "Authentication failed"]) {
      expect(classifyRunErrorKind(msg)).toBe("auth");
    }
  });

  it("限流与网络抖动（pi 会先自动重试，重试耗尽才落到这里）", () => {
    expect(classifyRunErrorKind("429 Too Many Requests")).toBe("rateLimit");
    expect(classifyRunErrorKind("Provider overloaded")).toBe("rateLimit");
    expect(classifyRunErrorKind("fetch failed")).toBe("network");
    expect(classifyRunErrorKind("getaddrinfo ENOTFOUND api.example.com")).toBe("network");
    expect(classifyRunErrorKind("request timed out")).toBe("network");
  });

  it("上下文超长优先于其他关键字（exceed/overflow 不误判成额度）", () => {
    expect(classifyRunErrorKind("This model's maximum context length is 200000 tokens")).toBe("overflow");
    expect(classifyRunErrorKind("prompt is too long: 210000 tokens > 200000 maximum")).toBe("overflow");
  });

  it("空/未知错误归 other，并给出兜底文案", () => {
    expect(classifyRunErrorKind(undefined)).toBe("other");
    expect(classifyRunErrorKind("   ")).toBe("other");
    expect(classifyRunErrorKind("something odd happened")).toBe("other");
    const info = classifyRunError("");
    expect(info.kind).toBe("other");
    expect(info.title).toBeTruthy();
    expect(info.hint).toBeTruthy();
    // 原始错误现在直接铺在错误卡里，建议文案不该再让人去点一个「详情」
    expect(info.hint).not.toContain("详情");
  });
});

/**
 * SSRF 防护单测（评审 R3-C7）：私网/回环/保留段判定、数字 IP 变体、URL 校验。
 * 全部离线可跑（域名用例走 .invalid 必 NXDOMAIN，fail-closed 不依赖网络）。
 */
import { describe, expect, it } from "vitest";
import { assertPublicHttpUrl, isPrivateHost, isPrivateIp } from "../src/agent-host/tools/ssrf.js";

describe("isPrivateIp", () => {
  it("回环/私网/链路本地/CGNAT/保留段全部命中", () => {
    for (const ip of [
      "127.0.0.1",
      "127.1.2.3",
      "0.0.0.0",
      "10.0.0.1",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // 云 metadata
      "100.64.0.1", // CGNAT
      "192.0.2.1", // 文档保留段
      "224.0.0.1", // 组播
      "255.255.255.255",
      "::1",
      "::",
      "::ffff:127.0.0.1", // IPv4-mapped
      "fd00::1", // ULA
      "fe80::1", // link-local
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it("公网地址不误伤（172.15/172.32 不在私网段）", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "100.63.0.1", "2606:4700:4700::1111"]) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });
});

describe("isPrivateHost", () => {
  it("localhost 系/.local/.internal/云 metadata", () => {
    for (const h of ["localhost", "foo.localhost", "router.local", "nas.internal", "metadata.google.internal"]) {
      expect(isPrivateHost(h), h).toBe(true);
    }
  });

  it("数字 IP 变体（2130706433 = 0x7f000001 = 127.0.0.1）", () => {
    expect(isPrivateHost("2130706433")).toBe(true);
    expect(isPrivateHost("0x7f000001")).toBe(true);
  });

  it("公网域名/公网 IP 放行", () => {
    expect(isPrivateHost("example.com")).toBe(false);
    expect(isPrivateHost("8.8.8.8")).toBe(false);
  });
});

describe("assertPublicHttpUrl", () => {
  it("非 http(s)/内嵌凭据/无法解析 → 拒", async () => {
    expect((await assertPublicHttpUrl("file:///etc/passwd")).ok).toBe(false);
    expect((await assertPublicHttpUrl("ftp://example.com/x")).ok).toBe(false);
    expect((await assertPublicHttpUrl("http://user:pass@example.com/")).ok).toBe(false);
    expect((await assertPublicHttpUrl("not a url")).ok).toBe(false);
  });

  it("字面私网 IP/localhost → 拒（不经 DNS）", async () => {
    expect((await assertPublicHttpUrl("http://127.0.0.1:8080/admin")).ok).toBe(false);
    expect((await assertPublicHttpUrl("http://[::1]/")).ok).toBe(false);
    expect((await assertPublicHttpUrl("http://169.254.169.254/latest/meta-data")).ok).toBe(false);
    expect((await assertPublicHttpUrl("http://192.168.1.1/")).ok).toBe(false);
    expect((await assertPublicHttpUrl("http://localhost:3000")).ok).toBe(false);
  });

  it("字面公网 IP → 过（不经 DNS）", async () => {
    expect((await assertPublicHttpUrl("https://1.1.1.1/")).ok).toBe(true);
  });

  it(".invalid 域名 DNS 必失败 → fail-closed 拒绝（离线也可跑）", async () => {
    const r = await assertPublicHttpUrl("https://nonexistent-host-xyz.invalid/");
    expect(r.ok).toBe(false);
  });
});

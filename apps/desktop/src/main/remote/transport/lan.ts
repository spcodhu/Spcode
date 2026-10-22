/**
 * 局域网 Transport（M1）：
 * - HTTP 静态服务：托管 apps/mobile 的 PWA 构建产物；目录不存在时服务占位页
 *   （明确说明 PWA 未构建，避免把 404 留给用户猜）；
 * - WebSocket 服务端（仅 /ws 路径升级），监听 0.0.0.0，端口 0 = 随机；
 * - 安全：只读静态目录，路径解析后强制限定在 staticDir 内（防目录穿越），
 *   不执行任何来自远程的路径拼接写操作。
 */

import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { extname, resolve, sep } from "node:path";
import { getLocale, i18n } from "@spcode/shared/i18n";
import WebSocket, { WebSocketServer } from "ws";
import type { PeerConnection, RemoteTransport } from "./types.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
}

/** Render per request so an already-running transport follows locale changes. */
function placeholderHtml(): string {
  return `<!doctype html>
<html lang="${escapeHtml(getLocale())}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(i18n.t("main:lan.title"))}</title></head>
<body style="font-family:system-ui;background:#0b0f14;color:#dbe4ee;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0">
<div style="max-width:560px;padding:24px;line-height:1.7">
<h2>${escapeHtml(i18n.t("main:lan.started"))}</h2>
<p>${escapeHtml(i18n.t("main:lan.notBuilt", { path: "apps/mobile/dist" }))}</p>
<p>${escapeHtml(i18n.t("main:lan.instructions"))}</p>
</div></body></html>`;
}

/** 私网 / 局域网 v4 段：RFC1918 + 链路本地 + CGNAT（Tailscale 100.64/10） */
function isLanIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** 局域网 v4 地址列表：优先私网段；一个都没有时退回全部非回环 v4（特殊组网兜底） */
export function lanIPv4Addresses(): string[] {
  const all: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      // @types/node 新版 family 只有字符串，老版本 Node 运行时是数字——两种都认
      const fam: unknown = info.family;
      if ((fam === "IPv4" || fam === 4) && !info.internal) all.push(info.address);
    }
  }
  const privateOnly = all.filter(isLanIPv4);
  return privateOnly.length > 0 ? privateOnly : all;
}

export interface LanTransportOptions {
  /** 监听端口；0 = 随机 */
  port: number;
  /** PWA 构建产物目录（不存在时服务占位页） */
  staticDir: string;
  host?: string;
}

class LanPeer implements PeerConnection {
  readonly id = randomUUID();
  private readonly msgCbs: ((frame: unknown) => void)[] = [];
  private readonly closeCbs: (() => void)[] = [];

  constructor(private readonly ws: WebSocket) {
    ws.on("message", (data: Buffer) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return; // 非 JSON 帧直接丢弃
      }
      for (const cb of this.msgCbs) cb(parsed);
    });
    const fireClose = () => {
      for (const cb of this.closeCbs) cb();
    };
    ws.on("close", fireClose);
    ws.on("error", () => this.ws.close());
  }

  send(frame: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  onMessage(cb: (frame: unknown) => void): void {
    this.msgCbs.push(cb);
  }

  onClose(cb: () => void): void {
    this.closeCbs.push(cb);
  }

  close(): void {
    this.ws.close();
  }
}

export class LanTransport implements RemoteTransport {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private connCb: ((peer: PeerConnection) => void) | null = null;
  private readonly peers = new Set<LanPeer>();
  private boundPort = 0;

  constructor(private readonly opts: LanTransportOptions) {}

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => this.serveHttp(req.url ?? "/", res));
    // maxPayload 与 relay 同口径（评审 R3-C9：默认 100MB 太大）
    const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
    server.on("upgrade", (req, socket, head) => {
      let pathname = "/";
      try {
        pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      } catch {
        // 非法 URL 按根路径处理，最终也会被拒绝
      }
      if (pathname !== "/ws") {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.acceptPeer(ws));
    });
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise);
      server.listen(this.opts.port, this.opts.host ?? "0.0.0.0", () => {
        server.off("error", rejectPromise);
        resolvePromise();
      });
    });
    // 运行期 server 错误（如客户端异常断开触发）不能是未捕获异常（评审 R3-C9）
    server.on("error", (err) => console.warn("[remote/lan] server error", err));
    const addr = server.address();
    this.boundPort = typeof addr === "object" && addr ? addr.port : this.opts.port;
    this.server = server;
    this.wss = wss;
  }

  async stop(): Promise<void> {
    const server = this.server;
    const wss = this.wss;
    if (!server) return;
    this.server = null;
    this.wss = null;
    for (const peer of this.peers) peer.close();
    this.peers.clear();
    await new Promise<void>((resolvePromise) => {
      wss?.close();
      // closeAllConnections：主动掐掉 keep-alive 连接，否则端口不释放、重启 EADDRINUSE（评审 R3-C9）
      server.closeAllConnections?.();
      server.close(() => resolvePromise());
      // server.close 只在所有连接结束后回调；500ms 兜底
      setTimeout(resolvePromise, 500).unref();
    });
  }

  onConnection(cb: (peer: PeerConnection) => void): void {
    this.connCb = cb;
  }

  getPort(): number {
    return this.boundPort;
  }

  getAdvertisedUrls(): string[] {
    if (!this.server || !this.boundPort) return [];
    return lanIPv4Addresses().map((ip) => `http://${ip}:${this.boundPort}`);
  }

  private acceptPeer(ws: WebSocket): void {
    const peer = new LanPeer(ws);
    this.peers.add(peer);
    peer.onClose(() => this.peers.delete(peer));
    this.connCb?.(peer);
  }

  /** 静态文件服务：限定在 staticDir 内；SPA 回退 index.html；目录不存在时占位页 */
  private serveHttp(rawUrl: string, res: ServerResponse): void {
    const dir = resolve(this.opts.staticDir);
    if (existsSync(dir) && statSync(dir).isDirectory()) {
      let pathname = "/";
      try {
        pathname = decodeURIComponent(new URL(rawUrl, "http://localhost").pathname);
      } catch {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end(i18n.t("main:lan.badRequest"));
        return;
      }
      const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const abs = resolve(dir, rel);
      // 防目录穿越：解析结果必须仍在 staticDir 内
      if (abs !== dir && !abs.startsWith(dir + sep)) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end(i18n.t("main:lan.forbidden"));
        return;
      }
      // statSync 与 existsSync 之间有 TOCTOU 窗口（评审 R3-C9）：异常按不存在处理
      const safeStatIsFile = (p: string): boolean => {
        try {
          return statSync(p).isFile();
        } catch {
          return false;
        }
      };
      const target = existsSync(abs) && safeStatIsFile(abs) ? abs : resolve(dir, "index.html");
      if (existsSync(target) && safeStatIsFile(target)) {
        res.writeHead(200, { "content-type": MIME[extname(target).toLowerCase()] ?? "application/octet-stream" });
        createReadStream(target).pipe(res);
        return;
      }
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(placeholderHtml());
  }
}

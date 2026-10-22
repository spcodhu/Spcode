import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

function worker(
  query = "defaultLocale=zh-CN&locale=zh-CN&supportedLocales=zh-CN,en",
  saved?: { locale: string; title: string },
  cacheFails = false,
) {
  const listeners = new Map<string, (event: unknown) => void>();
  let entry = saved;
  const showNotification = vi.fn(async () => {});
  const focus = vi.fn(async () => {});
  const openWindow = vi.fn(async () => {});
  runInNewContext(source, {
    URL,
    Response,
    self: {
      location: { href: `https://example.invalid/sw.js?${query}` },
      registration: { scope: "https://example.invalid/", showNotification },
      addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    },
    caches: {
      async open() {
        if (cacheFails) throw new Error("cache disabled");
        return {
          match: async () => (entry ? new Response(JSON.stringify(entry)) : undefined),
          put: async (_url: string, response: Response) => {
            entry = await response.json();
          },
        };
      },
    },
    clients: { matchAll: async () => [{ focus }], openWindow },
  });
  return {
    showNotification,
    focus,
    openWindow,
    async emit(type: string, data: Record<string, unknown> = {}) {
      let work: Promise<unknown> = Promise.resolve();
      listeners.get(type)?.({
        ...data,
        waitUntil: (promise: Promise<unknown>) => {
          work = promise;
        },
      });
      await work;
    },
  };
}

describe("service-worker localized push fallback", () => {
  it("persists only locale and generic title and uses them for empty push payloads", async () => {
    const sw = worker();
    await sw.emit("message", {
      data: { type: "locale.changed", locale: "en", title: "Spcod Remote Control", task: "private task" },
    });
    await sw.emit("push");
    expect(sw.showNotification).toHaveBeenCalledWith("Spcod Remote Control", { body: "" });
    expect(JSON.stringify(sw.showNotification.mock.calls)).not.toContain("private task");
  });

  it("preserves desktop-localized payloads and ignores arbitrary malformed plaintext", async () => {
    const sw = worker();
    await sw.emit("push", { data: { json: () => ({ title: "Spcod", body: "An action needs approval." }) } });
    expect(sw.showNotification).toHaveBeenLastCalledWith("Spcod", { body: "An action needs approval." });
    await sw.emit("push", {
      data: {
        json() {
          throw new Error("invalid JSON");
        },
        text: () => "private task content",
      },
    });
    expect(sw.showNotification).toHaveBeenLastCalledWith("Spcod 远程控制", { body: "" });
  });

  it("respects fixed English builds even when a prior build cached Chinese", async () => {
    const sw = worker("defaultLocale=en&locale=en&supportedLocales=en", { locale: "zh-CN", title: "旧标题" });
    await sw.emit("message", { data: { type: "locale.changed", locale: "zh-CN", title: "不支持" } });
    await sw.emit("push");
    expect(sw.showNotification).toHaveBeenCalledWith("Spcod Remote Control", { body: "" });
  });

  it("falls back to the registration locale if browser cache access fails", async () => {
    const sw = worker("defaultLocale=en&locale=en&supportedLocales=en", undefined, true);
    await sw.emit("message", { data: { type: "locale.changed", locale: "en" } });
    await sw.emit("push");
    expect(sw.showNotification).toHaveBeenCalledWith("Spcod Remote Control", { body: "" });
  });

  it("still focuses the PWA when the notification is clicked", async () => {
    const sw = worker();
    const close = vi.fn();
    await sw.emit("notificationclick", { notification: { close } });
    expect(close).toHaveBeenCalledOnce();
    expect(sw.focus).toHaveBeenCalledOnce();
    expect(sw.openWindow).not.toHaveBeenCalled();
  });
});

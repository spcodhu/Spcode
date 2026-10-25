import type { PermissionRequest, QuestionRequest, ScheduleTask, SessionMeta } from "@spcode/shared";
import { getLocale, i18n, localeProfile, resolveLocale, setLocale } from "@spcode/shared/i18n";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { PermissionCard } from "../src/components/PermissionCard";
import { ScheduleEditorSheet } from "../src/components/ScheduleEditor";
import { SettingsSheet } from "../src/components/SettingsSheet";
import type { RemoteClientCallbacks } from "../src/lib/client";
import type { PairingRecord } from "../src/lib/db";
import {
  applyDesktopLocale,
  describeMobileSchedule,
  errorText,
  formatDate,
  formatNumber,
  initializeMobileLocale,
  LOCALE_CACHE_KEY,
  MobileError,
  mobileText,
  workerScriptUrl,
} from "../src/lib/i18n";
import { PairPage } from "../src/pages/PairPage";
import { SchedulesPage } from "../src/pages/SchedulesPage";
import { SessionDetailPage } from "../src/pages/SessionDetailPage";
import { SessionsPage } from "../src/pages/SessionsPage";
import { attachPairedRecord, boot, getClient, replyQuestion, unpair } from "../src/state/controller";
import { useAppStore } from "../src/state/store";

const mocks = vi.hoisted(() => ({
  callbacks: [] as RemoteClientCallbacks[],
  loadPairing: vi.fn<() => Promise<PairingRecord | null>>(),
  command: vi.fn(async (cmd: { type: string }) => (cmd.type === "session.list" ? { sessions: [] } : { tasks: [] })),
}));

vi.mock("../src/lib/db", () => ({
  loadPairing: mocks.loadPairing,
  savePairing: vi.fn(async () => {}),
  clearPairing: vi.fn(async () => {}),
}));
vi.mock("../src/lib/client", () => ({
  RemoteClient: class {
    command = mocks.command;
    constructor(
      _record: PairingRecord,
      private cb: RemoteClientCallbacks,
    ) {
      mocks.callbacks.push(cb);
    }
    start() {
      this.cb.onState("connecting");
    }
    stop() {
      this.cb.onState("stopped");
    }
  },
  pairWithQr: vi.fn(),
}));
// SSR normally reads Zustand's initial snapshot. Use the current snapshot to test rendered
// screens against controller events without adding a DOM implementation or touching real storage.
vi.mock("../src/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/state/store")>();
  const hook = Object.assign(
    (selector: (state: ReturnType<typeof actual.useAppStore.getState>) => unknown) =>
      selector(actual.useAppStore.getState()),
    actual.useAppStore,
  );
  return { ...actual, useAppStore: hook };
});

const record: PairingRecord = {
  version: 1,
  desktopPk: "desktop-public-key",
  deviceId: "test-device",
  hosts: ["http://127.0.0.1"],
  deviceName: "原始 Device Name",
  keyPair: { publicKey: "public", secretKey: "test-only" },
  pairedAt: 1,
};
const session: SessionMeta = {
  id: "session-i18n",
  mode: "project",
  cwd: "/workspace/原始 project",
  title: "原始 Session Title",
  model: null,
  thinkingLevel: "off",
  createdAt: 1,
  updatedAt: 2,
};
const schedule: ScheduleTask = {
  id: "schedule-i18n",
  name: "原始 Schedule Name",
  prompt: "原始 prompt {{untouched}}",
  target: { kind: "project", cwd: session.cwd },
  frequency: "weekly",
  hour: 9,
  minute: 5,
  weekday: 1,
  enabled: true,
  createdAt: 1,
  lastRunAt: 2,
  lastStatus: "error",
  lastError: "原始 raw failure",
};
const permission: PermissionRequest = {
  requestId: "permission-i18n",
  sessionId: session.id,
  toolName: "原始Tool",
  args: { command: "原始 command" },
  risk: "danger",
};
const question: QuestionRequest = {
  requestId: "question-i18n",
  sessionId: session.id,
  questions: [{ question: "原始 model question", options: [{ value: "unchanged-value", label: "原始 label" }] }],
};

function render(element: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, element));
}
function callback(): RemoteClientCallbacks {
  return mocks.callbacks[mocks.callbacks.length - 1]!;
}
async function connect(): Promise<void> {
  attachPairedRecord(record);
  callback().onState("ready");
  // Let the normal session/schedule refresh settle before supplying the test snapshots.
  await Promise.resolve();
  await Promise.resolve();
}

let storage: Map<string, string>;
beforeEach(async () => {
  getClient()?.stop();
  useAppStore.getState().reset();
  mocks.callbacks.length = 0;
  mocks.command.mockClear();
  mocks.loadPairing.mockResolvedValue(null);
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  vi.stubGlobal("document", { documentElement: { lang: "", dir: "" }, title: "" });
  setLocale(localeProfile.defaultLocale);
});
afterEach(() => {
  getClient()?.stop();
  vi.unstubAllGlobals();
});

describe("mobile locale lifecycle", () => {
  it("initializes synchronously from cache, not browser language, and updates document metadata", () => {
    storage.set(LOCALE_CACHE_KEY, "en");
    initializeMobileLocale();
    expect(getLocale()).toBe(resolveLocale("en"));
    expect(document.documentElement.lang).toBe(getLocale());
    expect(document.documentElement.dir).toBe("ltr");
    expect(document.title).toBe(mobileText("app.title"));
  });

  it("uses profile default for empty, invalid, or inaccessible storage", () => {
    for (const cached of ["", "fr", '"en"']) {
      storage.set(LOCALE_CACHE_KEY, cached);
      initializeMobileLocale();
      expect(getLocale()).toBe(resolveLocale(undefined));
    }
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    });
    expect(() => initializeMobileLocale()).not.toThrow();
    expect(getLocale()).toBe(resolveLocale(undefined));
    expect(() => applyDesktopLocale("en")).not.toThrow();
    expect(getLocale()).toBe(resolveLocale("en"));
  });

  it("boots unpaired in cached locale even when pairing storage is unavailable", async () => {
    storage.set(LOCALE_CACHE_KEY, "en");
    mocks.loadPairing.mockRejectedValueOnce(new Error("private mode"));
    await boot();
    expect(useAppStore.getState().route).toEqual({ name: "pair" });
    expect(getLocale()).toBe(resolveLocale("en"));
    expect(render(createElement(PairPage))).toContain(mobileText("pair.title"));
  });

  it("gates snapshot-before-hello, applies desktop language before opening the gate, and caches it", async () => {
    storage.set(LOCALE_CACHE_KEY, "zh-CN");
    initializeMobileLocale();
    await connect();
    callback().onEvent({ type: "session.snapshot", sessions: [session] });
    callback().onEvent({ type: "permission.request", request: permission });
    expect(useAppStore.getState().localeReady).toBe(false);
    expect(render(createElement(App))).toContain('hidden="" data-testid="session-content"');
    const atReady: string[] = [];
    const off = useAppStore.subscribe((state, previous) => {
      if (state.localeReady && !previous.localeReady) atReady.push(getLocale());
    });
    callback().onEvent({ type: "remote.hello", vapidPublicKey: "", locale: "en" });
    off();
    expect(atReady).toEqual([resolveLocale("en")]);
    expect(storage.get(LOCALE_CACHE_KEY)).toBe(resolveLocale("en"));
    const html = render(createElement(App));
    expect(html).not.toContain('hidden="" data-testid="session-content"');
    expect(html).toContain(mobileText("permission.dangerTitle"));
  });

  it("falls back to profile default for hello without locale and follows live locale changes", async () => {
    applyDesktopLocale("en");
    await connect();
    callback().onEvent({ type: "remote.hello", vapidPublicKey: "" });
    expect(getLocale()).toBe(resolveLocale(undefined));
    expect(useAppStore.getState().localeReady).toBe(true);
    callback().onEvent({ type: "locale.changed", locale: "en" });
    expect(getLocale()).toBe(resolveLocale("en"));
    expect(document.documentElement.lang).toBe(resolveLocale("en"));
  });

  it("keeps offline data accessible and re-gates at reconnect without clearing output", async () => {
    await connect();
    callback().onEvent({ type: "remote.hello", vapidPublicKey: "", locale: "en" });
    callback().onEvent({ type: "session.snapshot", sessions: [session] });
    callback().onEvent({ type: "session.output", sessionId: session.id, chunk: "原始 offline output", seq: 0 });
    callback().onState("reconnecting");
    expect(getLocale()).toBe(resolveLocale("en"));
    expect(render(createElement(App))).not.toContain('hidden="" data-testid="session-content"');
    callback().onState("ready");
    expect(useAppStore.getState().localeReady).toBe(false);
    expect(useAppStore.getState().outputs[session.id]?.[0]?.chunk).toBe("原始 offline output");
    callback().onEvent({ type: "remote.hello", vapidPublicKey: "", locale: "zh-CN" });
    expect(getLocale()).toBe(resolveLocale("zh-CN"));
  });

  it("preserves cached locale when unpairing and never writes pairing data into locale storage", async () => {
    await connect();
    callback().onEvent({ type: "remote.hello", vapidPublicKey: "", locale: "en" });
    await unpair();
    expect(storage.get(LOCALE_CACHE_KEY)).toBe(resolveLocale("en"));
    expect([...storage.values()]).not.toContain(record.keyPair.secretKey);
  });

  it("announces connection state appropriately and exposes an explicit re-pair action", () => {
    useAppStore.getState().setConn("connecting");
    expect(render(createElement(App))).toContain('role="status"');
    useAppStore.getState().setConn("unpaired");
    const html = render(createElement(App));
    expect(html).toContain('role="alert"');
    expect(html).toContain(mobileText("connection.repair"));
  });
});

describe("localized rendering keeps raw content unchanged", () => {
  it("keeps snapshots, model output, to-dos, approvals, questions and schedules verbatim across switches", async () => {
    await connect();
    callback().onEvent({ type: "session.snapshot", sessions: [session] });
    callback().onEvent({ type: "session.output", sessionId: session.id, chunk: "原始 model output {{token}}", seq: 0 });
    callback().onEvent({
      type: "session.todo",
      sessionId: session.id,
      todos: [{ content: "原始 todo", status: "in_progress" }],
    });
    callback().onEvent({ type: "permission.request", request: permission });
    callback().onEvent({ type: "question.request", request: question });
    useAppStore.getState().setSchedules([schedule]);
    const { sessions, outputs, todos, permissions, questions, schedules } = useAppStore.getState();
    for (const locale of ["en", "zh-CN"] as const) {
      callback().onEvent({ type: "locale.changed", locale });
      const state = useAppStore.getState();
      expect(state.sessions).toBe(sessions);
      expect(state.outputs).toBe(outputs);
      expect(state.todos).toBe(todos);
      expect(state.permissions).toBe(permissions);
      expect(state.questions).toBe(questions);
      expect(state.schedules).toBe(schedules);
      const detail = render(createElement(SessionDetailPage, { sessionId: session.id }));
      expect(detail).toContain(session.title);
      expect(detail).toContain(session.cwd);
      expect(detail).toContain("原始 model output {{token}}");
      expect(detail).toContain("原始 todo");
      expect(detail).toContain(mobileText("session.send"));
      const list = render(createElement(SessionsPage));
      expect(list).toContain(session.title);
      expect(list).toContain(mobileText("sessions.title"));
      const tasks = render(createElement(SchedulesPage));
      expect(tasks).toContain(schedule.name);
      expect(tasks).toContain(schedule.lastError);
      expect(tasks).toContain(describeMobileSchedule(schedule));
      const editor = render(createElement(ScheduleEditorSheet, { task: schedule, onClose() {} }));
      expect(editor).toContain(schedule.prompt);
      expect(editor).toContain(mobileText("schedule.edit"));
      const card = render(createElement(PermissionCard, { request: permission }));
      expect(card).toContain(permission.toolName);
      expect(card).toContain("原始 command");
      expect(card).toContain(mobileText("permission.dangerWarning"));
      expect(render(createElement(SettingsSheet, { onClose() {} }))).toContain(record.deviceName);
    }
    const answers = { "0": { kind: "options" as const, values: ["unchanged-value"] } };
    await replyQuestion(question.requestId, answers);
    expect(mocks.command).toHaveBeenCalledWith({ type: "question.reply", requestId: question.requestId, answers });
  });

  it("translates local error keys at display time without changing raw remote/browser errors", () => {
    const owned = new MobileError("error.notConnected");
    const raw = new Error("原始 error: not connected {{message}}");
    for (const locale of ["en", "zh-CN"] as const) {
      applyDesktopLocale(locale);
      expect(errorText(owned)).toBe(mobileText("error.notConnected"));
      expect(errorText(raw)).toBe("原始 error: not connected {{message}}");
    }
  });

  it("uses explicit current locale for dates, numbers, schedules and the worker profile", () => {
    applyDesktopLocale("en");
    expect(formatNumber(12345)).toBe(new Intl.NumberFormat(getLocale()).format(12345));
    expect(formatDate(1000)).toBe(
      new Intl.DateTimeFormat(getLocale(), {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(1000),
    );
    for (const frequency of ["once", "hourly", "daily", "weekday", "weekly"] as const) {
      expect(describeMobileSchedule({ ...schedule, frequency, runAt: 1000 })).not.toMatch(/schedule\./);
    }
    const workerUrl = new URL(workerScriptUrl(), "https://example.invalid/");
    expect(workerUrl.searchParams.get("locale")).toBe(getLocale());
    expect(workerUrl.searchParams.get("supportedLocales")).toBe(localeProfile.supportedLocales.join(","));
  });
});

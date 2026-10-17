/**
 * 输入框草稿（composerDrafts）单测：
 * 稳定 key / set-clear 语义 / 空草稿剔除 / deleteSession 清理。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { composerDraftKeyOf, type SessionState, useStore } from "../src/renderer/src/store.js";

vi.stubGlobal("window", {
  spcode: {
    removeSession: vi.fn(async () => {}),
    setComposerDrafts: vi.fn(async () => {}),
  },
});

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    meta: { id: "s1", mode: "chat", cwd: "", title: "t", model: null, thinkingLevel: "off", createdAt: 0, updatedAt: 0 },
    messages: [],
    running: false,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      costInput: 0, costOutput: 0, costCacheRead: 0, costCacheWrite: 0, costTotal: 0, count: 0,
    },
    lastUsage: null,
    supportedThinkingLevels: [],
    todos: [],
    planMode: false,
    ...overrides,
  };
}

beforeEach(() => {
  useStore.setState({ composerDrafts: {}, sessions: {}, sessionOrder: [], activeSessionId: null, registrySessions: [] });
});

describe("composerDraftKeyOf（稳定 key）", () => {
  it("正式会话用 sessionId", () => {
    expect(composerDraftKeyOf(makeSession(), "s1")).toBe("s1");
  });

  it("draft 会话用 mode+cwd：会话对象重建后仍命中同一份草稿", () => {
    const draftA = makeSession({ draft: true });
    const draftB = makeSession({ draft: true, meta: { ...makeSession().meta, id: "another-draft-id" } });
    expect(composerDraftKeyOf(draftA, "draft-uuid-1")).toBe("draft:chat:");
    expect(composerDraftKeyOf(draftB, "draft-uuid-2")).toBe("draft:chat:");
  });

  it("项目会话 key 含 cwd，不同目录互不串扰", () => {
    const p = makeSession({ draft: true, meta: { ...makeSession().meta, mode: "project", cwd: "/a/b" } });
    expect(composerDraftKeyOf(p, "x")).toBe("draft:project:/a/b");
  });
});

describe("setComposerDraft / clearComposerDraft", () => {
  it("新建草稿并合并 patch", () => {
    const { setComposerDraft } = useStore.getState();
    setComposerDraft("k1", { text: "你好" });
    setComposerDraft("k1", { inputMode: "markdown" });
    const d = useStore.getState().composerDrafts.k1;
    expect(d?.text).toBe("你好");
    expect(d?.inputMode).toBe("markdown");
    expect(d?.updatedAt).toBeGreaterThan(0);
  });

  it("内容全空且为纯文本模式 → 删 key（保持 map 干净）", () => {
    const { setComposerDraft } = useStore.getState();
    setComposerDraft("k1", { text: "x" });
    setComposerDraft("k1", { text: "  " });
    expect(useStore.getState().composerDrafts.k1).toBeUndefined();
  });

  it("仅切换 MD 模式（无文本）也保留草稿（模式本身要按会话记住）", () => {
    const { setComposerDraft } = useStore.getState();
    setComposerDraft("k1", { inputMode: "markdown" });
    expect(useStore.getState().composerDrafts.k1?.inputMode).toBe("markdown");
  });

  it("clearComposerDraft 删除 key；对不存在的 key 幂等", () => {
    const { setComposerDraft, clearComposerDraft } = useStore.getState();
    setComposerDraft("k1", { text: "x" });
    clearComposerDraft("k1");
    expect(useStore.getState().composerDrafts.k1).toBeUndefined();
    clearComposerDraft("nope"); // 不抛错
  });
});

describe("deleteSession 清理草稿", () => {
  it("删除会话时同步删除其输入框草稿", async () => {
    const s = makeSession({ draft: true });
    useStore.setState({
      sessions: { s1: s },
      sessionOrder: ["s1"],
      activeSessionId: "s1",
    });
    useStore.getState().setComposerDraft("s1", { text: "未发送的内容" });
    await useStore.getState().deleteSession("s1");
    expect(useStore.getState().composerDrafts.s1).toBeUndefined();
    expect(useStore.getState().sessions.s1).toBeUndefined();
  });
});

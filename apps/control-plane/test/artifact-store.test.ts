import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSuperAgentStore } from "../src/store-sqlite.js";

const homes: string[] = [];
afterEach(() => {
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

describe("私有 Artifact Store", () => {
  it("内容寻址、元数据与哈希读取一致", () => {
    const home = mkdtempSync(join(tmpdir(), "spcode-artifact-test-"));
    homes.push(home);
    const store = new SqliteSuperAgentStore(join(home, "control.sqlite"));
    const { workItemId } = store.execute(
      {
        type: "workitem.create",
        requestId: "req_artifact",
        repo: "owner/repo",
        title: "Artifact",
        request: "保存产物",
      },
      "local-device",
    );
    const artifact = store.artifacts.put({
      workItemId,
      kind: "diff",
      content: "diff --git a/a b/a\n",
      mimeType: "text/x-diff",
    });
    expect(artifact.visibility).toBe("private");
    expect(artifact.size).toBeGreaterThan(0);
    expect(store.artifacts.read(artifact).toString()).toBe("diff --git a/a b/a\n");
    expect(store.artifacts.list().map((item) => item.id)).toContain(artifact.id);
    expect(store.snapshot().artifacts?.map((item) => item.id)).toContain(artifact.id);
    expect(store.db.prepare("PRAGMA user_version").get()!.user_version).toBe(5);
    store.close();
  });

  it("内容相同复用存储，类型与空内容失败关闭", () => {
    const home = mkdtempSync(join(tmpdir(), "spcode-artifact-test-"));
    homes.push(home);
    const store = new SqliteSuperAgentStore(join(home, "control.sqlite"));
    const first = store.artifacts.put({ kind: "log", content: "same" });
    const second = store.artifacts.put({ kind: "log", content: "same" });
    expect(second.id).toBe(first.id);
    expect(() => store.artifacts.put({ kind: "log", content: "" })).toThrow(/为空/);
    expect(() => store.artifacts.put({ kind: "html", content: "<script>x</script>", mimeType: "text/html" })).toThrow(
      /不允许/,
    );
    store.close();
  });
});

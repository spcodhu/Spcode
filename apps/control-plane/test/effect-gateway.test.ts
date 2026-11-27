import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EffectRequestInput, effectInputHash } from "@spcode/shared/effect";
import { afterEach, describe, expect, it } from "vitest";
import { EffectGateway } from "../src/effect-gateway.js";
import { SqliteSuperAgentStore } from "../src/store-sqlite.js";
import { WorkerStore } from "../src/worker-store.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "spcode-effect-test-"));
  const store = new SqliteSuperAgentStore(join(home, "control.sqlite"));
  const workers = new WorkerStore(store.db, () => {});
  const gateway = new EffectGateway(store, workers);
  cleanups.push(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
  const { workItemId } = store.execute(
    { type: "workitem.create", requestId: "req_effect", repo: "owner/repo", title: "Effect", request: "执行副作用" },
    "local-device",
  );
  store.execute(
    {
      type: "plan.submit",
      workItemId: workItemId!,
      content: "计划",
      baseSha: "abc",
      verification: ["pnpm test"],
      changeScope: ["src/**"],
      publishIntent: true,
      effectIntent: [
        "nginx.reload",
        "deployment.apply",
        "dns.upsert",
        "artifact.report",
        "git.push",
        "git.pr",
        "system.exec",
      ],
    },
    "local-device",
  );
  const plan = store.snapshot().plans[0]!;
  store.execute(
    { type: "plan.approve", workItemId: workItemId!, planId: plan.id, planHash: plan.planHash },
    "local-device",
  );
  const input: EffectRequestInput = {
    workItemId: workItemId!,
    planHash: plan.planHash,
    expectedRevision: plan.revision,
    type: "nginx.reload",
    resource: "local/nginx",
    input: { config: "events {}", targetPath: "/etc/nginx/nginx.conf", reload: false },
    idempotencyKey: "effect-key-1",
  };
  return { store, workers, gateway, input };
}

describe("EffectGateway 授权与执行", () => {
  it("独立批准、幂等、双 Executor 竞争、stale fence 与 UNKNOWN 对账", () => {
    const { store, gateway, input } = fixture();
    const requested = gateway.request(input, "local-device");
    expect(requested.status).toBe("PENDING_APPROVAL");
    expect(gateway.request(input, "local-device").id).toBe(requested.id);
    expect(() => gateway.request({ ...input, idempotencyKey: "other", planHash: "old" }, "local-device")).toThrow(
      /过期/,
    );
    const inputHash = createHash("sha256").update(effectInputHash(input)).digest("hex");
    expect(gateway.approve(requested.id, inputHash, "local-device").status).toBe("PENDING");
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE kind = 'EFFECT_EXECUTE'").get()!.n).toBe(1);
    const first = gateway.claim("executor-a")!;
    expect(first.fence).toBe(1);
    expect(gateway.claim("executor-b")).toBeNull();
    expect(() =>
      gateway.complete(first.id, "executor-a", first.fence + 1, { status: "SUCCEEDED", evidence: {} }),
    ).toThrow(/stale fence/);
    gateway.complete(first.id, "executor-a", first.fence, {
      status: "SUCCEEDED",
      externalId: "external-1",
      evidence: { ok: true },
    });
    expect(gateway.record(first.id).status).toBe("SUCCEEDED");
    const second = gateway.request({ ...input, idempotencyKey: "effect-key-2" }, "local-device");
    gateway.approve(
      second.id,
      createHash("sha256")
        .update(effectInputHash({ ...input, idempotencyKey: "effect-key-2" }))
        .digest("hex"),
      "local-device",
    );
    const running = gateway.claim("executor-a")!;
    store.db.prepare("UPDATE effect_leases SET expires_at = 0 WHERE effect_id = ?").run(running.id);
    gateway.recoverStale();
    expect(gateway.record(running.id).status).toBe("UNKNOWN");
    expect(() => gateway.retry(running.id)).toThrow(/UNKNOWN/);
    expect(
      gateway.reconcile(running.id, { status: "SUCCEEDED", externalId: "confirmed", evidence: { checked: true } })
        .status,
    ).toBe("SUCCEEDED");
  });
});

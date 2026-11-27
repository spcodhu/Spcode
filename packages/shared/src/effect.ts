export const EFFECT_PROTOCOL_VERSION = 1 as const;

export type EffectType =
  | "artifact.report"
  | "git.push"
  | "git.pr"
  | "nginx.reload"
  | "deployment.apply"
  | "dns.upsert"
  | "system.exec";

export interface EffectRequestInput {
  workItemId: string;
  planHash: string;
  expectedRevision: number;
  type: EffectType;
  resource: string;
  input: Record<string, unknown>;
  idempotencyKey: string;
}

export interface EffectResult {
  status: "SUCCEEDED" | "FAILED" | "UNKNOWN";
  externalId?: string;
  evidence: Record<string, unknown>;
  retryable?: boolean;
}

export interface EffectRecord {
  id: string;
  requestId: string;
  workItemId: string;
  type: EffectType;
  resource: string;
  status: string;
  fence: number;
  externalId: string | null;
  result: EffectResult | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface EffectProvider {
  readonly type: EffectType;
  execute(request: EffectRequestInput & { effectId: string; fence: number }): Promise<EffectResult>;
}

export function effectInputHash(input: EffectRequestInput): string {
  return JSON.stringify({ type: input.type, resource: input.resource, input: input.input });
}

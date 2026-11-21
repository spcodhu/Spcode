/** Local context estimates are NOT provider billing or an additive decomposition of usage. */
export interface ContextMeasure {
  tokens: number | null;
  status: "estimated" | "reported" | "configured" | "unknown";
  source: "local-characters" | "provider-usage" | "compaction-settings" | "unknown";
}

export type ContextPart =
  | "systemHost"
  | "rulesMemory"
  | "toolSchema"
  | "summaries"
  | "recentMessages"
  | "toolResults"
  | "readEvidence";

export interface ContextDetails {
  /** Changes when the local projection, model or request measurement changes. */
  revision: string;
  basis: "last-request" | "session-projection";
  parts: Record<ContextPart, ContextMeasure>;
  /** Latest successful provider-reported INPUT including cache reads/writes, excluding output. */
  providerInput: ContextMeasure;
  /** Independent headroom, never added to occupied tokens or provider input. */
  outputReserve: ContextMeasure;
  warning: "fixed-overhead" | null;
}

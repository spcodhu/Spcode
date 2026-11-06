import { Type } from "typebox";

export const DEFAULT_SHELL_TIMEOUT_SECONDS = 120;
export const MAX_SHELL_TIMEOUT_SECONDS = 600;

export const SHELL_TIMEOUT_DESCRIPTION_NOTE =
  " Commands time out after 120 seconds by default; pass timeout in seconds to allow a longer bounded run (maximum 600 seconds).";

export const shellTimeoutField = Type.Optional(
  Type.Number({
    description: "Timeout in seconds (default 120, must be > 0, maximum 600)",
    exclusiveMinimum: 0,
    maximum: MAX_SHELL_TIMEOUT_SECONDS,
    default: DEFAULT_SHELL_TIMEOUT_SECONDS,
  }),
);

export function effectiveShellTimeout(timeout?: number): number {
  if (timeout === undefined) return DEFAULT_SHELL_TIMEOUT_SECONDS;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_SHELL_TIMEOUT_SECONDS) {
    throw new Error(
      `Invalid timeout: must be a finite number greater than 0 and at most ${MAX_SHELL_TIMEOUT_SECONDS} seconds`,
    );
  }
  return timeout;
}

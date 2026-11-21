/** Process-local FIFO writer arbitration, shared by root tools and whole write Tasks.
 * An active lease is released in finally AFTER execution settles, never just on abort:
 * cancellation cannot retract a file write or a running subprocess.
 */
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export interface WorkspaceWriterOwner {
  /** Unique execution principal, not the shared parent session id. */
  principalId: string;
  ancestorIds?: readonly string[];
}
export interface WorkspaceWriterLease {
  readonly key: string;
  readonly owner: WorkspaceWriterOwner;
  release(): void;
}

export function abortError(): Error {
  return new DOMException("Operation cancelled", "AbortError");
}

/** Canonicalize existing ancestors too (new scratch directories, symlinks/junctions). */
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await canonicalPath(parent), relative(parent, path));
  }
}

/** Real Git worktree root (not common .git dir); otherwise the host-authorized root.
 * cwd must be inside that root. Never trust a model-supplied cwd/workspace key.
 */
export async function resolveWorkspaceWriterKey(
  cwd: string,
  authorizedRoot: string = cwd,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const [directory, root] = await Promise.all([canonicalPath(resolve(cwd)), canonicalPath(resolve(authorizedRoot))]);
  const rel = relative(root, directory);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error("Task cwd is outside its authorized workspace root");
  }
  const gitRoot = await new Promise<string | undefined>((accept, reject) => {
    execFile("git", ["-C", directory, "rev-parse", "--show-toplevel"], { signal, timeout: 5000 }, (error, stdout) => {
      if (signal?.aborted) reject(abortError());
      else if (error) accept(undefined);
      else accept(stdout.trim());
    });
  });
  signal?.throwIfAborted();
  const key = await canonicalPath(gitRoot || root);
  signal?.throwIfAborted();
  return process.platform === "win32" ? key.toLowerCase() : key;
}

interface Waiter {
  owner: WorkspaceWriterOwner;
  resolve: (lease: WorkspaceWriterLease) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort: () => void;
}
interface WriterState {
  owner?: WorkspaceWriterOwner;
  references: number;
  queue: Waiter[];
}

export class WorkspaceWriterManager {
  private readonly states = new Map<string, WriterState>();

  isHeldBy(key: string, principalId: string): boolean {
    return this.states.get(key)?.owner?.principalId === principalId;
  }

  /** A write Task cannot wait for a write descendant while retaining its own lease. */
  assertCanDelegateWrite(key: string, owner: WorkspaceWriterOwner): void {
    const holder = this.states.get(key)?.owner?.principalId;
    if (holder && owner.ancestorIds?.includes(holder)) {
      throw new Error("A writer cannot wait for a write child. Execute the write yourself or return it to the parent.");
    }
  }

  acquire(key: string, owner: WorkspaceWriterOwner, signal?: AbortSignal): Promise<WorkspaceWriterLease> {
    if (signal?.aborted) return Promise.reject(abortError());
    try {
      this.assertCanDelegateWrite(key, owner);
    } catch (error) {
      return Promise.reject(error);
    }
    let state = this.states.get(key);
    if (!state) {
      state = { references: 0, queue: [] };
      this.states.set(key, state);
    }
    if (!state.owner || state.owner.principalId === owner.principalId) {
      state.owner = owner;
      return Promise.resolve(this.lease(key, state, owner));
    }
    const queuedState = state;
    return new Promise((accept, reject) => {
      const waiter: Waiter = {
        owner,
        resolve: accept,
        reject,
        signal,
        onAbort: () => {
          const i = queuedState.queue.indexOf(waiter);
          if (i >= 0) queuedState.queue.splice(i, 1);
          signal?.removeEventListener("abort", waiter.onAbort);
          reject(abortError());
        },
      };
      queuedState.queue.push(waiter);
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      if (signal?.aborted) waiter.onAbort();
    });
  }

  private lease(key: string, state: WriterState, owner: WorkspaceWriterOwner): WorkspaceWriterLease {
    state.references++;
    let released = false;
    return {
      key,
      owner,
      release: () => {
        if (released) return;
        released = true;
        if (--state.references > 0) return;
        state.owner = undefined;
        let next = state.queue.shift();
        while (next?.signal?.aborted) {
          next.signal.removeEventListener("abort", next.onAbort);
          next.reject(abortError());
          next = state.queue.shift();
        }
        if (!next) {
          this.states.delete(key);
          return;
        }
        next.signal?.removeEventListener("abort", next.onAbort);
        state.owner = next.owner;
        next.resolve(this.lease(key, state, next.owner));
      },
    };
  }

  /** Root edit/write/Shell/unknown-effect tools MUST use this same manager.
   * For a write Task's own tools this is reentrant. Readonly tools need no lease.
   */
  async withLease<T>(key: string, owner: WorkspaceWriterOwner, signal: AbortSignal | undefined, run: () => Promise<T>) {
    const lease = await this.acquire(key, owner, signal);
    try {
      signal?.throwIfAborted();
      return await run();
    } finally {
      lease.release();
    }
  }

  get pendingCount(): number {
    return [...this.states.values()].reduce((n, state) => n + state.queue.length, 0);
  }
  get heldCount(): number {
    return this.states.size - [...this.states.values()].filter((state) => !state.owner).length;
  }
}

/** Shared across root sessions as well as descendant Tasks in this host process. */
export const workspaceWriterManager = new WorkspaceWriterManager();

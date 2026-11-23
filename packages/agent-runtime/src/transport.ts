import type { HostCommand, HostEvent } from "@spcode/shared";

interface ParentPort {
  postMessage(message: unknown): void;
  on(event: "message", callback: (event: { data: unknown }) => void): void;
}

export interface RuntimeTransport {
  emit(event: HostEvent): void;
  onCommand(callback: (command: HostCommand) => void): void;
}

/** Electron utilityProcess 与普通 Node child_process.fork 的传输无关适配。 */
export function createRuntimeTransport(): RuntimeTransport {
  const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
  if (parentPort) {
    return {
      emit: (event) => parentPort.postMessage(event),
      onCommand: (callback) => parentPort.on("message", (event) => callback(event.data as HostCommand)),
    };
  }
  if (typeof process.send === "function") {
    return {
      emit: (event) => {
        if (process.connected) process.send?.(event);
      },
      onCommand: (callback) => process.on("message", (message) => callback(message as HostCommand)),
    };
  }
  throw new Error("Agent Runtime requires Electron parentPort or Node IPC");
}

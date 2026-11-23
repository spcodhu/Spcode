import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ControlPlane } from "./server.js";

const here = dirname(fileURLToPath(import.meta.url));

/** 本地组合根；独立 Node 入口和测试共用，不 import Electron。 */
export function createLocalControlPlane(
  options: Partial<ConstructorParameters<typeof ControlPlane>[0]> = {},
): ControlPlane {
  return new ControlPlane({
    workbenchDir: options.workbenchDir ?? process.env.SPCODE_WORKBENCH_DIR ?? resolve(here, "../../workbench/dist"),
    ...options,
  });
}

import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  packages: "bundle",
  banner: {
    js: "import { createRequire as __spcodeCreateRequire } from 'node:module'; const require = __spcodeCreateRequire(import.meta.url);",
  },
};

for (const [entry, output] of [
  ["src/index.ts", "dist/index.mjs"],
  ["src/api.ts", "dist/api.mjs"],
  ["src/fake-worker.ts", "dist/fake-worker.mjs"],
  ["src/watchdog-main.ts", "dist/watchdog.mjs"],
  ["src/postgres-sync-worker.ts", "dist/postgres-sync-worker.mjs"],
  ["src/s3-sync-worker.ts", "dist/s3-sync-worker.mjs"],
  ["../../packages/agent-runtime/src/index.ts", "dist/agent-runtime.mjs"],
]) {
  await build({
    ...common,
    entryPoints: [resolve(root, entry)],
    outfile: resolve(root, output),
  });
}

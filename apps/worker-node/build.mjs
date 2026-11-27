import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [resolve(root, "src/main.ts")],
  outfile: resolve(root, "dist/index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  packages: "bundle",
  banner: { js: "import { createRequire as __spcodeCreateRequire } from 'node:module'; const require = __spcodeCreateRequire(import.meta.url);" },
});

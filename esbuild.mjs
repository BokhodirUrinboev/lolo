import * as esbuild from "esbuild";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";

// tree-sitter runtime + grammars are loaded from dist/wasm at runtime.
// Only the runtime and the grammars src/context/treeSitter.ts maps extensions to.
const GRAMMARS = /^tree-sitter(-(typescript|tsx|javascript|c-sharp|python|go|java|rust|cpp|php|ruby))?\.wasm$/;
rmSync("dist/wasm", { recursive: true, force: true });
mkdirSync("dist/wasm", { recursive: true });
for (const f of readdirSync("node_modules/@vscode/tree-sitter-wasm/wasm")) {
  if (GRAMMARS.test(f)) cpSync(`node_modules/@vscode/tree-sitter-wasm/wasm/${f}`, `dist/wasm/${f}`);
}

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

const contexts = await Promise.all([
  // Extension host bundle: `vscode` is provided at runtime.
  esbuild.context({ ...common, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js", external: ["vscode"] }),
  // Headless CLI (eval runner / manual testing): must never import `vscode`.
  esbuild.context({ ...common, entryPoints: ["src/cli.ts"], outfile: "dist/cli.js", banner: { js: "#!/usr/bin/env node" } }),
  // Eval harness: `node dist/eval.js run|export`.
  esbuild.context({ ...common, entryPoints: ["eval/runner.ts"], outfile: "dist/eval.js" }),
  // VS Code smoke test (not shipped).
  esbuild.context({ ...common, entryPoints: ["test/integration/smoke.ts"], outfile: "dist/test/smoke.js", external: ["vscode"] }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}

import * as path from "node:path";
import { fileSymbols } from "../context/treeSitter";
import type { FimContextFile } from "./fim";

const IMPORT_RES = [
  /\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g, // ES import
  /\brequire\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g, // CommonJS
  /^\s*from\s+(\.+[\w.]*)\s+import\b/gm, // Python relative import
];
const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", "/index.ts", "/index.js"];
const MAX_CHARS = 1500;

/**
 * Signatures of files the current file imports (relative imports only), for the FIM
 * prompt: lets the model use real names and parameter lists from those files.
 */
export async function importContext(
  filePath: string,
  text: string,
  read: (abs: string) => Promise<string | undefined>,
  relativeTo: (abs: string) => string,
): Promise<FimContextFile[]> {
  const specs = new Set<string>();
  for (const re of IMPORT_RES) for (const m of text.matchAll(re)) specs.add(m[1]);
  const out: FimContextFile[] = [];
  let used = 0;
  for (const spec of specs) {
    const base = spec.startsWith(".") && !spec.includes("/") ? pythonModule(filePath, spec) : path.resolve(path.dirname(filePath), spec);
    for (const ext of EXTENSIONS) {
      const abs = base + ext;
      const content = await read(abs);
      if (content === undefined) continue;
      const syms = await fileSymbols(abs, content);
      const sig = syms?.defs.map((d) => `${"  ".repeat(d.depth)}${d.signature}`).join("\n");
      if (sig && used + sig.length <= MAX_CHARS) {
        out.push({ path: relativeTo(abs), text: sig });
        used += sig.length;
      }
      break;
    }
  }
  return out;
}

/** `.models` / `..pkg.mod` relative to the importing file's package. */
function pythonModule(filePath: string, spec: string): string {
  const dots = /^\.+/.exec(spec)![0].length;
  let dir = path.dirname(filePath);
  for (let i = 1; i < dots; i++) dir = path.dirname(dir);
  const rest = spec.slice(dots).replace(/\./g, "/");
  return path.join(dir, rest) + (rest ? "" : "/__init__");
}

import { listFiles } from "../context/repoMap";
import type { ToolContext } from "./types";

const ESM = /^\s*(?:export\s+(?:default\b|const\b|let\b|var\b|function\b|async\b|class\b|\{)|import\s+(?:[\w*{][^'"]*\s+from\s+)?['"])/m;
const CJS = /\brequire\s*\(\s*['"]|\bmodule\.exports\b|^\s*exports\.\w+\s*=/m;
// The user asked for the other module system: a conversion is the task, not a mistake.
const CONVERTS = /\b(?:ESM|ES ?modules?|ECMAScript modules?|CommonJS|CJS)\b|import\/export|"type":\s*"module"/i;

/** The nearest package.json above `path` (workspace-relative), or undefined. */
async function nearestPackage(path: string, ctx: ToolContext): Promise<string | undefined> {
  const parts = path.split("/").slice(0, -1);
  for (let i = parts.length; i >= 0; i--) {
    const p = [...parts.slice(0, i), "package.json"].join("/");
    if ((await ctx.host.stat(p)) === "file") return p;
  }
  return undefined;
}

/**
 * New code in the other module system than the project's: `export` in a CommonJS project (models
 * write "exported from" as ESM) or `require` in a `"type": "module"` one. Node then fails, and
 * small models convert the whole project instead of the one file. Advice, or undefined.
 * `before` is the file's current content ("" for a new file): its own style stays allowed.
 */
export async function moduleSystemProblem(path: string, content: string, before: string, ctx: ToolContext): Promise<string | undefined> {
  const ext = path.match(/\.(c|m)?js$/)?.[1] ?? (path.endsWith(".js") ? "" : undefined);
  if (ext === undefined || CONVERTS.test(ctx.todo ?? "")) return undefined;
  const esm = ESM.test(content) && !ESM.test(before);
  const cjs = CJS.test(content) && !CJS.test(before);
  if (!esm && !cjs) return undefined;

  const pkg = await nearestPackage(path, ctx);
  let type: string | undefined;
  try {
    type = pkg ? JSON.parse(await ctx.host.readFile(pkg)).type : undefined;
  } catch {
    return undefined;
  }
  const projectEsm = ext === "m" || (ext === "" && type === "module");
  if (projectEsm && cjs) {
    return `${ext === "m" ? `${path} is an ES module (.mjs)` : `${pkg} has "type": "module"`}, so require and module.exports are not defined here. Use \`export function name\` / \`export { name }\` and \`import { name } from "./file.js"\`.`;
  }
  if (!esm || projectEsm) return undefined;
  if (ext === "" && type !== "commonjs") {
    // No "type": the project's own files decide (bundled front-end code uses import/export without it).
    const code = (await listFiles(ctx.host)).filter((f) => /\.js$/.test(f) && f !== path && !/(^|\/)(dist|build|out)\//.test(f)).slice(0, 12);
    let cjsFiles = 0;
    for (const f of code) {
      const text = await ctx.host.readFile(f).catch(() => "");
      if (ESM.test(text)) return undefined;
      if (CJS.test(text)) cjsFiles++;
    }
    if (!cjsFiles) return undefined;
  }
  const why = ext === "c" ? `${path} is a CommonJS file (.cjs)` : `This project uses CommonJS (require and module.exports; ${pkg ? `${pkg} has no "type": "module"` : "no package.json"})`;
  return `${why}, so export/import would fail in Node. Export with \`module.exports = { name }\` and load it with \`const { name } = require("./file")\`, like the other files do.`;
}

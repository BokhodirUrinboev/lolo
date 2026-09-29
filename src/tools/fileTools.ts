import { listFiles } from "../context/repoMap";
import { fileSymbols, languageFor } from "../context/treeSitter";
import { applyLineRange, editToolFor, EditTool, isLazyPlaceholder, mergeLazyRewrite } from "../edit/formats";
import { fuzzyApply, overlapCandidates, reindent } from "../edit/fuzzyApply";
import { checkEditSyntax, findImbalance } from "../edit/syntaxGuard";
import { collapseBlankRuns, detectEol, fromLf, maxBlankRun, numberLines, toLf } from "../edit/text";
import { IGNORED_DIRS } from "./paths";
import { symbolSummary } from "./output";
import { fail, ok, ToolContext, ToolDef, ToolResult } from "./types";

const MAX_READ_LINES = 400;

/**
 * A package added by editing the project file: models guess versions (EF Core 9 in a .NET 10
 * project), while the package manager picks the one that fits. Returns advice, or undefined.
 */
export function handAddedPackage(path: string, before: string, after: string): string | undefined {
  if (/\.(cs|fs|vb)proj$/.test(path)) {
    const refs = (t: string) => new Set([...t.matchAll(/<PackageReference\s+Include="([^"]+)"/gi)].map((m) => m[1].toLowerCase()));
    const old = refs(before);
    const added = [...after.matchAll(/<PackageReference\s+Include="([^"]+)"/gi)].map((m) => m[1]).filter((n) => !old.has(n.toLowerCase()));
    if (added.length) {
      const dir = path.split("/").slice(0, -1).join("/") || ".";
      return `Don't add NuGet packages by editing ${path}: run \`dotnet add package ${added[0]}\` with cwd "${dir}" (one command per package). It picks the version that matches the project's .NET version. The file was NOT changed.`;
    }
  }
  if (path === "package.json" || path.endsWith("/package.json")) {
    const deps = (t: string) => {
      try {
        const j = JSON.parse(t);
        return { ...j.dependencies, ...j.devDependencies } as Record<string, string>;
      } catch {
        return undefined;
      }
    };
    const was = deps(before);
    const now = deps(after);
    const added = was && now ? Object.keys(now).filter((n) => !(n in was)) : [];
    if (added.length) {
      const dir = path.split("/").slice(0, -1).join("/") || ".";
      return `Don't add packages by editing ${path}: run \`npm install ${added.join(" ")}\` (add -D for dev tools) with cwd "${dir}". It installs them and records a version that exists. The file was NOT changed.`;
    }
  }
  return undefined;
}

/** Files a project has exactly one of: a second Program.cs means two sets of top-level statements (CS8802). */
const ONE_PER_PROJECT = /^(Program\.cs|Startup\.cs|appsettings\.json|package\.json|tsconfig\.json|go\.mod|pyproject\.toml|Cargo\.toml|manage\.py)$/;
const PROJECT_FILE = /(\.csproj|\.fsproj|^package\.json|^go\.mod|^pyproject\.toml|^Cargo\.toml)$/;

/** An existing file with the same one-per-project name in the project `path` would belong to. */
async function projectTwin(path: string, ctx: ToolContext): Promise<string | undefined> {
  const name = path.split("/").pop()!;
  if (!ONE_PER_PROJECT.test(name)) return undefined;
  const files = await listFiles(ctx.host);
  const dirs = new Set(files.filter((f) => PROJECT_FILE.test(f.split("/").pop()!)).map((f) => f.split("/").slice(0, -1).join("/")));
  const projectOf = (p: string) => {
    const parts = p.split("/").slice(0, -1);
    for (let i = parts.length; i >= 0; i--) if (dirs.has(parts.slice(0, i).join("/"))) return parts.slice(0, i).join("/");
    return undefined;
  };
  const project = projectOf(path);
  if (project === undefined) return undefined;
  return files.find((f) => f !== path && f.split("/").pop() === name && projectOf(f) === project);
}

const EDIT_HINT: Record<EditTool, string> = {
  rewrite_file: "rewrite_file with the complete new content",
  edit: "edit (search/replace)",
  edit_lines: "edit_lines with the line numbers shown",
};

/** Keeps the original EOL style, trailing newline and blank-line spacing; models drift on all three. */
function matchFileEnding(before: string, after: string): string {
  const eol = detectEol(before);
  const lf = collapseBlankRuns(toLf(after), Math.max(2, maxBlankRun(before)));
  let out = fromLf(lf, eol);
  if (before.endsWith(eol) && !out.endsWith(eol)) out += eol;
  return out;
}

/**
 * Hard format constraints only: rewrite_file is limited to small files (output size),
 * edit_lines needs a numbered view. `edit` is always allowed; read_file recommends
 * the best tool per file, and the syntax guard catches broken splices.
 */
async function mustUse(tool: EditTool, path: string, ctx: ToolContext): Promise<string | undefined> {
  if (tool === "edit") return undefined;
  const lines = toLf(await ctx.host.readFile(path)).split("\n").length;
  const want = editToolFor(ctx.profile, ctx.edits, path, lines);
  if (tool === "rewrite_file" && ctx.profile.editFormat !== "whole" && lines > ctx.profile.wholeFileMaxLines) {
    return `${path} has ${lines} lines, too many for rewrite_file (max ${ctx.profile.wholeFileMaxLines}). Use ${EDIT_HINT[want]}.`;
  }
  if (tool === "edit_lines" && want !== "edit_lines") return `edit_lines needs a numbered view of the file. Use ${EDIT_HINT[want]} for ${path}.`;
  return undefined;
}

/** Existing files with the same name as `path` (plans guess folders before generators have run). */
async function sameName(path: string, ctx: ToolContext): Promise<string[]> {
  const name = path.split("/").pop()!;
  return (await listFiles(ctx.host)).filter((f) => f !== path && f.split("/").pop() === name).slice(0, 5);
}

async function mustBeFile(path: string, ctx: ToolContext): Promise<string | undefined> {
  const kind = await ctx.host.stat(path);
  if (kind === null) {
    const same = await sameName(path, ctx);
    if (same.length) return `File "${path}" does not exist, but ${same.join(", ")} does. Use that path: the plan guessed the folder.`;
    return `File "${path}" does not exist. To create it, use create_file (it creates missing folders); to find an existing file, use list_dir or search.`;
  }
  if (kind === "dir") return `"${path}" is a directory. Use list_dir.`;
  return undefined;
}

export const readFile: ToolDef<{ path: string; start_line?: number; end_line?: number }> = {
  name: "read_file",
  kind: "read",
  description: `Read a file. Optional start_line/end_line (1-based) for a range; at most ${MAX_READ_LINES} lines are returned.`,
  params: {
    type: "object",
    properties: { path: { type: "string" }, start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 } },
    required: ["path"],
  },
  check: (a, ctx) => mustBeFile(a.path, ctx),
  async run(a, ctx) {
    const raw = await ctx.host.readFile(a.path);
    // An empty file shown as just the edit hint made models copy the hint into `search`.
    if (!raw.trim()) {
      const how = ctx.readOnly ? "" : ` To fill it, use rewrite_file with the complete content.`;
      return ok(`${a.path} is empty (no content yet).${how}`, `read_file ${a.path}: empty`);
    }
    const lines = toLf(raw).split("\n");
    const start = Math.min(a.start_line ?? 1, lines.length);
    const end = Math.min(a.end_line ?? lines.length, lines.length, start + MAX_READ_LINES - 1);
    const slice = lines.slice(start - 1, end);
    // Line numbers only once the file is in line-range mode; otherwise models copy them into `search`.
    const body = ctx.edits.isLineRange(a.path) ? numberLines(slice, start) : slice.join("\n");
    const range = start === 1 && end === lines.length ? `${lines.length} lines` : `lines ${start}-${end} of ${lines.length}`;
    const more = end < lines.length ? `\n[${lines.length - end} more lines; read again with start_line=${end + 1}]` : "";
    const symbols = symbolSummary(slice.join("\n"));
    const big = lines.length > ctx.profile.wholeFileMaxLines && !!languageFor(a.path);
    if (big) ctx.largeFiles = true;
    const tip = big ? `\n[Big file: read_symbol reads just one function or class by name.]` : "";
    const hint = ctx.readOnly ? "" : `\n[To change this file use ${EDIT_HINT[editToolFor(ctx.profile, ctx.edits, a.path, lines.length)]}.]`;
    return ok(`${a.path} (${range}):\n${body}${more}${hint}${tip}`, `read_file ${a.path}: ${range}${symbols ? `; ${symbols}` : ""}`);
  },
};

export const readSymbol: ToolDef<{ path: string; symbol: string }> = {
  name: "read_symbol",
  kind: "read",
  group: "symbols",
  description: "Read only one function, method or class of a big file by name (`symbol`, or `Class.method`). Small files are returned whole.",
  params: { type: "object", properties: { path: { type: "string" }, symbol: { type: "string", minLength: 1 } }, required: ["path", "symbol"] },
  async check(a, ctx) {
    const bad = await mustBeFile(a.path, ctx);
    if (bad) return bad;
    return languageFor(a.path) ? undefined : `read_symbol does not support ${a.path}. Use read_file with start_line/end_line.`;
  },
  async run(a, ctx) {
    const raw = await ctx.host.readFile(a.path);
    // A partial view of a small file made the model rewrite_file it and drop the unseen parts (module.exports).
    if (toLf(raw).split("\n").length <= ctx.profile.wholeFileMaxLines) return readFile.run({ path: a.path }, ctx);
    const defs = (await fileSymbols(a.path, raw))?.defs ?? [];
    const parts = a.symbol.split(/[.:#]+/).filter(Boolean);
    const name = parts[parts.length - 1] ?? a.symbol;
    const parent = parts[parts.length - 2];
    const found = defs.filter(
      (d) => d.name === name && (!parent || defs.some((p) => p !== d && p.name === parent && p.line <= d.line && p.endLine >= d.endLine)),
    );
    if (!found.length) {
      const names = [...new Set(defs.map((d) => d.name))].slice(0, 25).join(", ");
      return fail(`No symbol "${a.symbol}" in ${a.path}.${names ? ` Symbols here: ${names}.` : " No symbols found; use read_file."}`, `read_symbol ${a.path}#${a.symbol}: not found`);
    }
    const lines = toLf(raw).split("\n");
    const numbered = ctx.edits.isLineRange(a.path);
    const blocks = found.slice(0, 3).map((d) => {
      const end = Math.min(d.endLine, d.line + MAX_READ_LINES - 1);
      const slice = lines.slice(d.line - 1, end);
      const cut = end < d.endLine ? `\n[${d.endLine - end} more lines; use read_file with start_line=${end + 1}]` : "";
      return `${a.path} lines ${d.line}-${d.endLine} (${d.name}):\n${numbered ? numberLines(slice, d.line) : slice.join("\n")}${cut}`;
    });
    const extra = found.length > 3 ? `\n[${found.length - 3} more matches; qualify the name as Class.method]` : "";
    const hint = ctx.readOnly ? "" : `\n[To change this file use ${EDIT_HINT[editToolFor(ctx.profile, ctx.edits, a.path, lines.length)]}.]`;
    return ok(blocks.join("\n\n") + extra + hint, `read_symbol ${a.path}#${a.symbol}: lines ${found[0].line}-${found[0].endLine}`);
  },
};

export const listDir: ToolDef<{ path?: string }> = {
  name: "list_dir",
  kind: "read",
  description: "List a directory (default: workspace root). Directories end with /.",
  params: { type: "object", properties: { path: { type: "string" } } },
  async check(a, ctx) {
    const kind = await ctx.host.stat(a.path ?? ".");
    if (kind === "dir") return undefined;
    return kind === "file" ? `"${a.path}" is a file, not a folder. Use read_file.` : `Folder "${a.path}" does not exist. create_file creates missing folders.`;
  },
  async run(a, ctx) {
    const dir = a.path ?? ".";
    const entries = (await ctx.host.listDir(dir))
      .filter((e) => !(e.type === "dir" && IGNORED_DIRS.has(e.name)))
      .sort((x, y) => (x.type === y.type ? x.name.localeCompare(y.name) : x.type === "dir" ? -1 : 1));
    const shown = entries.slice(0, 200).map((e) => e.name + (e.type === "dir" ? "/" : ""));
    const more = entries.length > shown.length ? `\n[${entries.length - shown.length} more]` : "";
    return ok(`${dir}/:\n${shown.join("\n") || "(empty)"}${more}`, `list_dir ${dir}: ${entries.length} entries`);
  },
};

/**
 * A `// existing implementation` / `// ... rest of the code` line that `before` doesn't have:
 * in new code it is a hole, not code (a moved function written as a stub). Error text, or undefined.
 */
function placeholderIn(text: string, before: string, path: string): string | undefined {
  if (!languageFor(path) && !BRACE_FILE.test(path)) return undefined;
  const known = new Set(toLf(before).split("\n").map((l) => l.trim()));
  const hole = toLf(text).split("\n").find((l) => isLazyPlaceholder(l, known));
  return hole
    ? `\`${hole.trim()}\` is a placeholder, not code. Write the real code${before ? "" : " (read the file the code comes from, and copy it)"}; nothing may be left out.`
    : undefined;
}

interface Def {
  name: string;
  line: number;
  endLine: number;
}

/** The innermost function/class around each line (tree-sitter); undefined outside any, or without a grammar. */
async function enclosingDefs(path: string, text: string, lines: number[]): Promise<(Def | undefined)[]> {
  const defs = (await fileSymbols(path, text))?.defs ?? [];
  return lines.map((l) => defs.filter((d) => d.line <= l && d.endLine >= l).sort((x, y) => x.endLine - x.line - (y.endLine - y.line))[0]);
}

/**
 * `search` is the first line(s) of a function or class and `replace` a complete new version of
 * it (balanced brackets, same name): the model means to replace the whole definition. Applied
 * literally, the old body would stay behind as a dead `{ ... }` block, which still parses in JS.
 * Returns the file with the whole definition replaced, when that parses; brace languages only.
 */
async function redefinition(path: string, original: string, search: string, replace: string, startLine: number) {
  if (!BRACE_FILE.test(path)) return undefined;
  const lines = toLf(original).split("\n");
  const def = ((await fileSymbols(path, original))?.defs ?? []).find((d) => d.line === startLine && d.endLine > d.line);
  const s = toLf(search).replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, "");
  const r = toLf(replace).replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, "");
  if (!def || s.split("\n").length >= def.endLine - def.line + 1) return undefined; // search already spans it
  const rLines = r.split("\n");
  if (!rLines[0].includes(def.name) || !r.includes("{") || findImbalance(r) || rLines.length < 2) return undefined;
  const body = reindent(r, [rLines[0]], [lines[def.line - 1]]);
  const content = fromLf([...lines.slice(0, def.line - 1), ...body, ...lines.slice(def.endLine)].join("\n"), detectEol(original));
  if (await checkEditSyntax(path, original, content)) return undefined;
  return { content, name: def.name, from: def.line, to: def.endLine };
}

const BRACE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|cs|java|kt|go|rs|c|h|cpp|hpp|cc|swift|php|dart|scala)$/i;

/** `fragment`: the text the model wrote for this edit (to spot a reply cut off by an unescaped quote). */
async function write(ctx: ToolContext, path: string, content: string, isNew: boolean, reason: string, note = "", fragment = content): Promise<ToolResult> {
  const before = isNew ? undefined : await ctx.host.readFile(path);
  if (before !== undefined) content = matchFileEnding(before, content);
  if (content === before) {
    return {
      ...fail(`No change: ${path} already has exactly this content. If the current todo is complete, call done now; otherwise do the next step.`, `${reason}: no change`),
      noop: true,
    };
  }
  const pkg = before !== undefined ? handAddedPackage(path, before, content) : undefined;
  if (pkg) return fail(pkg, `${reason}: rejected (package added by hand)`);
  const broken = await checkEditSyntax(path, before, content, fragment);
  if (broken) {
    ctx.edits.recordFailure(path);
    return fail(broken, `${reason}: rejected (syntax error)`);
  }
  const outcome = await ctx.host.proposeWrite(path, content, { isNew, reason });
  if (!outcome.applied) {
    const said = outcome.note ? ` They said: ${outcome.note}` : "";
    return fail(`The user rejected this change to ${path}.${said} Do what they asked, or try a different approach.`, `${reason}: rejected by user`);
  }
  ctx.edits.recordSuccess(path);
  if (outcome.note) {
    return ok(`${isNew ? "Created" : "Edited"} ${path}, but ${outcome.note}, so the file differs from your proposal. Re-read it before editing again.`, `${reason}: partly applied (${outcome.note})`, [path]);
  }
  return ok(`${isNew ? "Created" : "Edited"} ${path}.${note}`, `${reason}: applied`, [path]);
}

export const editFile: ToolDef<{ path: string; search: string; replace: string; all?: boolean }> = {
  name: "edit",
  kind: "write",
  description:
    "Replace one block of a file. `search` must be copied exactly from the file (a few whole lines, unique); `replace` is the new text for those lines. " +
    "all=true replaces every exact occurrence (e.g. renaming an identifier).",
  params: {
    type: "object",
    properties: { path: { type: "string" }, search: { type: "string", minLength: 1 }, replace: { type: "string" }, all: { type: "boolean" } },
    required: ["path", "search", "replace"],
  },
  async check(a, ctx) {
    return (await mustBeFile(a.path, ctx)) ?? placeholderIn(a.replace, await ctx.host.readFile(a.path), a.path);
  },
  async run(a, ctx) {
    const original = await ctx.host.readFile(a.path);
    let r = fuzzyApply(original, a.search, a.replace, { all: a.all });
    let where = "";
    // Several matches: the ones inside the function the todo (or the model's thought) names are meant.
    const context = `${ctx.todo ?? ""}\n${ctx.thought ?? ""}`;
    const named = (d: Def | undefined) => !!d && new RegExp(`(?<![\\w$])${d.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`).test(context);
    if (!r.ok && r.matches) {
      const matches = r.matches;
      const owners = await enclosingDefs(a.path, original, matches);
      const inNamed = matches.filter((_, i) => named(owners[i]));
      const picked = inNamed.length === 1 ? fuzzyApply(original, a.search, a.replace, { at: inNamed[0] }) : undefined;
      if (picked?.ok) {
        where = ` (\`search\` matched ${matches.length} places; changed the one in ${owners[matches.indexOf(inNamed[0])]!.name} at line ${inNamed[0]})`;
        r = picked;
      } else {
        const places = matches.map((l, i) => `line ${l}${owners[i] ? ` (in ${owners[i]!.name})` : ""}`).join(", ");
        r = { ...r, reason: `\`search\` matches ${matches.length} places: ${places}. Include the line above or below it (e.g. the function's first line) so it matches only one.` };
      }
    } else if (r.ok && a.all && (r.replaced?.length ?? 0) > 1) {
      // all=true across functions while the todo is about one of them: only that one (the others were collateral).
      const owners = await enclosingDefs(a.path, original, r.replaced!);
      const targets = [...new Set(owners.filter(named))];
      if (targets.length === 1 && owners.some((o) => o !== targets[0])) {
        const limited = fuzzyApply(original, a.search, a.replace, { all: true, within: [targets[0]!.line, targets[0]!.endLine] });
        if (limited.ok && limited.replaced?.length) {
          where = ` (only in ${targets[0]!.name}, which the task is about: ${limited.replaced.length} of ${r.replaced!.length} occurrences)`;
          r = limited;
        }
      }
    }
    if (r.ok) {
      let note = where || (r.strategy === "exact" ? "" : ` (matched ${r.strategy} at line ${r.startLine}, score ${r.score})`);
      let content = r.content;
      const whole = a.all ? undefined : await redefinition(a.path, original, a.search, a.replace, r.startLine);
      if (whole) {
        content = whole.content;
        note += ` (\`replace\` is a complete new ${whole.name}, so it replaced the whole old one, lines ${whole.from}-${whole.to})`;
      }
      // `replace` repeating the lines around `search` (a second closing brace): replace them instead, if that parses.
      if (!whole && !a.all && (await checkEditSyntax(a.path, original, content, a.replace))) {
        const searchLines = toLf(a.search).replace(/^(?:[ \t]*\n)+/, "").replace(/(?:\n[ \t]*)+$/, "").split("\n").length;
        for (const c of overlapCandidates(original, content, r.startLine, searchLines)) {
          if (await checkEditSyntax(a.path, original, c)) continue;
          content = c;
          note += " (your `replace` repeated lines next to `search`; they were replaced, not duplicated)";
          break;
        }
      }
      return write(ctx, a.path, content, false, `edit ${a.path}`, note, a.replace);
    }
    const switched = ctx.edits.recordFailure(a.path);
    let out = `Edit failed: ${r.reason}`;
    if (r.closest) out += `\nClosest match (similarity ${r.closest.score}):\n${r.closest.text}`;
    if (switched || ctx.edits.isLineRange(a.path)) {
      const lines = toLf(original).split("\n");
      out +=
        `\n\nSwitching ${a.path} to line-based editing. Use edit_lines with start_line/end_line from these numbered lines:\n` +
        numberLines(lines.slice(0, MAX_READ_LINES)) +
        (lines.length > MAX_READ_LINES ? `\n[${lines.length - MAX_READ_LINES} more lines; use read_file with start_line]` : "");
    }
    return fail(out, `edit ${a.path}: failed (${r.reason.split(".")[0]})`);
  },
};

export const rewriteFile: ToolDef<{ path: string; content: string }> = {
  name: "rewrite_file",
  kind: "write",
  description: "Replace the entire content of an existing small file. Write the complete file: never use placeholders like `// ... existing code ...`.",
  params: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  async check(a, ctx) {
    return (await mustBeFile(a.path, ctx)) ?? mustUse("rewrite_file", a.path, ctx);
  },
  async run(a, ctx) {
    const original = await ctx.host.readFile(a.path);
    const merged = mergeLazyRewrite(original, a.content);
    if (!merged.ok) return fail(merged.reason, `rewrite_file ${a.path}: placeholders could not be merged`);
    const note = merged.filled ? ` (${merged.filled} "existing code" placeholder(s) were filled from the original)` : "";
    return write(ctx, a.path, merged.content, false, `rewrite_file ${a.path}`, note);
  },
};

export const editLines: ToolDef<{ path: string; start_line: number; end_line: number; content: string }> = {
  name: "edit_lines",
  kind: "write",
  description: "Replace lines start_line..end_line (inclusive, 1-based) with `content`. Use end_line = start_line - 1 to insert. Only for files shown with line numbers.",
  params: {
    type: "object",
    properties: {
      path: { type: "string" },
      start_line: { type: "integer", minimum: 1 },
      end_line: { type: "integer", minimum: 0 },
      content: { type: "string" },
    },
    required: ["path", "start_line", "end_line", "content"],
  },
  async check(a, ctx) {
    return (await mustBeFile(a.path, ctx)) ?? mustUse("edit_lines", a.path, ctx);
  },
  async run(a, ctx) {
    const r = applyLineRange(await ctx.host.readFile(a.path), a.start_line, a.end_line, a.content);
    if (!r.ok) return fail(`edit_lines failed: ${r.reason}`);
    return write(ctx, a.path, r.content, false, `edit_lines ${a.path}:${a.start_line}-${a.end_line}`, "", a.content);
  },
};

export const createFile: ToolDef<{ path: string; content: string }> = {
  name: "create_file",
  kind: "write",
  description: "Create a new file (parent folders are created). Fails if the file exists.",
  params: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  async check(a, ctx) {
    if (await ctx.host.stat(a.path)) return `"${a.path}" already exists. Use edit to change it.`;
    const base = a.path.split("/").pop()!;
    if (/^\.(slnx?|csproj|fsproj|cs|py|js|ts|tsx|json|go|rs|java)$/.test(base)) {
      return `"${base}" has no file name, only an extension. Name it (e.g. TodoApi${base})${/sln/.test(base) ? ", or better run `dotnet new sln -n <Name>` and `dotnet sln add <project>`" : ""}.`;
    }
    const twin = await projectTwin(a.path, ctx);
    if (twin) return `${twin} already exists in this project, and a second ${a.path.split("/").pop()} would break it. Edit ${twin} instead.`;
    // An empty file is a wasted step (and then an edit on nothing); only markers may be empty.
    if (!a.content.trim() && !/(^|\/)(__init__\.py|\.gitkeep|\.keep|py\.typed)$/.test(a.path)) {
      return `content is empty. Create ${a.path} with its complete content in this call.`;
    }
    return placeholderIn(a.content, "", a.path);
  },
  run: (a, ctx) => write(ctx, a.path, collapseBlankRuns(toLf(a.content), 2), true, `create_file ${a.path}`),
};

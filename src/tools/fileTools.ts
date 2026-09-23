import { applyLineRange, editToolFor, EditTool, mergeLazyRewrite } from "../edit/formats";
import { fuzzyApply } from "../edit/fuzzyApply";
import { checkEditSyntax } from "../edit/syntaxGuard";
import { collapseBlankRuns, detectEol, fromLf, maxBlankRun, numberLines, toLf } from "../edit/text";
import { IGNORED_DIRS } from "./paths";
import { symbolSummary } from "./output";
import { fail, ok, ToolContext, ToolDef, ToolResult } from "./types";

const MAX_READ_LINES = 400;

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

async function mustBeFile(path: string, ctx: ToolContext): Promise<string | undefined> {
  const kind = await ctx.host.stat(path);
  if (kind === null) return `File "${path}" does not exist. To create it, use create_file (it creates missing folders); to find an existing file, use list_dir or search.`;
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
    const lines = toLf(await ctx.host.readFile(a.path)).split("\n");
    const start = Math.min(a.start_line ?? 1, lines.length);
    const end = Math.min(a.end_line ?? lines.length, lines.length, start + MAX_READ_LINES - 1);
    const slice = lines.slice(start - 1, end);
    // Line numbers only once the file is in line-range mode; otherwise models copy them into `search`.
    const body = ctx.edits.isLineRange(a.path) ? numberLines(slice, start) : slice.join("\n");
    const range = start === 1 && end === lines.length ? `${lines.length} lines` : `lines ${start}-${end} of ${lines.length}`;
    const more = end < lines.length ? `\n[${lines.length - end} more lines; read again with start_line=${end + 1}]` : "";
    const symbols = symbolSummary(slice.join("\n"));
    const hint = ctx.readOnly ? "" : `\n[To change this file use ${EDIT_HINT[editToolFor(ctx.profile, ctx.edits, a.path, lines.length)]}.]`;
    return ok(`${a.path} (${range}):\n${body}${more}${hint}`, `read_file ${a.path}: ${range}${symbols ? `; ${symbols}` : ""}`);
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

async function write(ctx: ToolContext, path: string, content: string, isNew: boolean, reason: string, note = ""): Promise<ToolResult> {
  const before = isNew ? undefined : await ctx.host.readFile(path);
  if (before !== undefined) content = matchFileEnding(before, content);
  if (content === before) {
    return {
      ...fail(`No change: ${path} already has exactly this content. If the current todo is complete, call done now; otherwise do the next step.`, `${reason}: no change`),
      noop: true,
    };
  }
  const broken = await checkEditSyntax(path, before, content);
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
  check: (a, ctx) => mustBeFile(a.path, ctx),
  async run(a, ctx) {
    const original = await ctx.host.readFile(a.path);
    const r = fuzzyApply(original, a.search, a.replace, { all: a.all });
    if (r.ok) {
      const note = r.strategy === "exact" ? "" : ` (matched ${r.strategy} at line ${r.startLine}, score ${r.score})`;
      return write(ctx, a.path, r.content, false, `edit ${a.path}`, note);
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
    return write(ctx, a.path, r.content, false, `edit_lines ${a.path}:${a.start_line}-${a.end_line}`);
  },
};

export const createFile: ToolDef<{ path: string; content: string }> = {
  name: "create_file",
  kind: "write",
  description: "Create a new file (parent folders are created). Fails if the file exists.",
  params: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  async check(a, ctx) {
    return (await ctx.host.stat(a.path)) ? `"${a.path}" already exists. Use edit to change it.` : undefined;
  },
  run: (a, ctx) => write(ctx, a.path, collapseBlankRuns(toLf(a.content), 2), true, `create_file ${a.path}`),
};

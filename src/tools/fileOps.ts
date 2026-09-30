import { listFiles } from "../context/repoMap";
import { importUpdates } from "./importPaths";
import { resolveWorkspacePath, writeForbidden } from "./paths";
import { fail, ok, ToolDef } from "./types";

function normalize(p: string, ctx: { host: { root: string } }): { path: string } | { error: string } {
  const r = resolveWorkspacePath(ctx.host.root, p);
  if ("error" in r) return r;
  if (r.path === ".") return { error: "the workspace root cannot be moved or deleted." };
  if (writeForbidden(r.path)) return { error: `${r.path} is not allowed.` };
  return r;
}

export const moveFile: ToolDef<{ from: string; to: string }> = {
  name: "move_file",
  kind: "write",
  group: "fileops",
  description: "Move or rename a file or folder (parent folders are created). The user is asked to confirm. Fails if the target exists.",
  params: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] },
  async check(a, ctx) {
    const from = normalize(a.from, ctx);
    if ("error" in from) return from.error;
    const to = normalize(a.to, ctx);
    if ("error" in to) return to.error;
    if (from.path === to.path) return "from and to are the same path.";
    if (to.path.startsWith(from.path + "/")) return "a folder cannot be moved into itself.";
    if (!(await ctx.host.stat(from.path))) return `"${from.path}" does not exist. Use list_dir or search to find it.`;
    if (await ctx.host.stat(to.path)) return `"${to.path}" already exists.`;
    a.from = from.path;
    a.to = to.path;
    return undefined;
  },
  async run(a, ctx) {
    const before = new Set(await listFiles(ctx.host));
    const r = await ctx.host.moveFile(a.from, a.to);
    if (!r.applied) {
      const said = r.note ? ` They said: ${r.note}` : "";
      return fail(`The user declined to move ${a.from}.${said}`, `move_file ${a.from}: declined`);
    }
    // Imports are fixed by code: the model tends to search for the path as written here, not as imported.
    const updates = (await ctx.host.stat(a.to)) === "file" ? await importUpdates(ctx, a.from, a.to, before) : [];
    let note = `Imports of it are not updated automatically for this file type: search for "${a.from.replace(/\.[^./]+$/, "").split("/").pop()}" and fix them.`;
    const changed = [a.to];
    if (updates.length) {
      const w = await ctx.host.proposeWrites(updates, `update imports of ${a.from}`);
      note = w.applied
        ? `Updated the imports in ${updates.map((u) => u.path).join(", ")}.`
        : `The user rejected the import updates for ${updates.map((u) => u.path).join(", ")}${w.note ? ` (${w.note})` : ""}; fix them yourself.`;
      if (w.applied) changed.push(...updates.map((u) => u.path).filter((p) => p !== a.to));
    } else if (/\.((c|m)?(j|t)sx?|py)$/.test(a.to)) {
      note = "No file imported it by a relative path or module name.";
    }
    (ctx.moved ??= new Map()).set(a.from, a.to);
    return ok(`Moved ${a.from} to ${a.to}. ${note}`, `move_file ${a.from} → ${a.to}${updates.length ? ` (+${updates.length} imports)` : ""}`, changed);
  },
};

export const deleteFile: ToolDef<{ path: string }> = {
  name: "delete_file",
  kind: "write",
  group: "fileops",
  description: "Delete a file or folder. The user is asked to confirm.",
  params: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  async check(a, ctx) {
    const p = normalize(a.path, ctx);
    if ("error" in p) return p.error;
    if (!(await ctx.host.stat(p.path))) return `"${p.path}" does not exist.`;
    a.path = p.path;
    return undefined;
  },
  async run(a, ctx) {
    const r = await ctx.host.deleteFile(a.path);
    if (!r.applied) {
      const said = r.note ? ` They said: ${r.note}` : "";
      return fail(`The user declined to delete ${a.path}.${said}`, `delete_file ${a.path}: declined`);
    }
    return ok(`Deleted ${a.path}.`, `delete_file ${a.path}: deleted`, [a.path]);
  },
};

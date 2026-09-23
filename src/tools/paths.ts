import * as path from "node:path";

/** Directories never listed, searched, or written by the agent. */
export const IGNORED_DIRS = new Set([".git", "node_modules", "bin", "obj", "dist", "out", "build", ".agent", ".vs", ".idea", "__pycache__", ".venv", "venv", "target", "coverage"]);

const WRITE_FORBIDDEN = [/^\.git(\/|$)/, /^\.agent\/(checkpoints|trajectories)(\/|$)/];

/**
 * Normalizes a model-supplied path to a workspace-relative POSIX path.
 * Returns an error string for paths outside the workspace.
 */
export function resolveWorkspacePath(root: string, p: string): { path: string } | { error: string } {
  let raw = p.trim().replace(/\\/g, "/");
  if (!raw) return { error: "path is empty" };
  if (raw.startsWith("@")) raw = raw.slice(1); // models echo @-mentions
  const abs = path.posix.isAbsolute(raw) || /^[a-zA-Z]:\//.test(raw) ? raw : path.posix.join(root.replace(/\\/g, "/"), raw);
  const rel = path.posix.relative(root.replace(/\\/g, "/"), path.posix.normalize(abs));
  if (rel.startsWith("..") || path.posix.isAbsolute(rel)) return { error: `path "${p}" is outside the workspace` };
  return { path: rel === "" ? "." : rel };
}

export function writeForbidden(rel: string): boolean {
  return WRITE_FORBIDDEN.some((re) => re.test(rel));
}

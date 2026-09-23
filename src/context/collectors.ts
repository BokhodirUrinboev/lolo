import { execFile } from "node:child_process";
import type { Host } from "../host/types";
import { formatDiagnostics } from "../tools/diagnostics";
import { fitTokens } from "./budget";

/** What the editor knows right now; VS Code fills this in, headless hosts leave it empty. */
export interface EditorContext {
  activeFile?: { path: string; cursorLine: number; selection?: { startLine: number; endLine: number; text: string } };
  openTabs?: string[];
  terminalOutput?: string;
}

const AROUND_CURSOR = 40;

/**
 * Gathers context the model would otherwise spend steps looking for: active file
 * around the cursor, selection, open tabs, errors, uncommitted changes.
 */
export async function collectContext(host: Host, editor: EditorContext | undefined, tokens: number): Promise<string> {
  const parts: string[] = [];
  const active = editor?.activeFile;
  if (active) {
    if (active.selection?.text.trim()) {
      parts.push(`Selected in ${active.path} (lines ${active.selection.startLine}-${active.selection.endLine}):\n${active.selection.text}`);
    }
    try {
      const lines = (await host.readFile(active.path)).replace(/\r\n/g, "\n").split("\n");
      const from = Math.max(0, active.cursorLine - 1 - AROUND_CURSOR);
      const to = Math.min(lines.length, active.cursorLine + AROUND_CURSOR);
      const whole = from === 0 && to === lines.length;
      parts.push(`Active file ${active.path}${whole ? "" : ` (lines ${from + 1}-${to} of ${lines.length}, cursor at ${active.cursorLine})`}:\n${lines.slice(from, to).join("\n")}`);
    } catch {
      /* unsaved or deleted */
    }
  }
  const tabs = editor?.openTabs?.filter((t) => t !== active?.path) ?? [];
  if (tabs.length) parts.push(`Open files: ${tabs.slice(0, 15).join(", ")}`);

  const errors = (await host.diagnostics()).filter((d) => d.severity === "error");
  if (errors.length) parts.push(`Current errors:\n${formatDiagnostics(errors, 20)}`);

  const diff = await gitDiffStat(host.root);
  if (diff) parts.push(`Uncommitted changes (git diff --stat):\n${diff}`);

  if (editor?.terminalOutput?.trim()) parts.push(`Last terminal output:\n${fitTokens(editor.terminalOutput.trim(), 800)}`);

  return fitTokens(parts.join("\n\n"), tokens);
}

function gitDiffStat(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", ["diff", "--stat", "HEAD"], { cwd, timeout: 5000 }, (err, stdout) => resolve(err ? "" : stdout.trim().split("\n").slice(-25).join("\n")));
  });
}

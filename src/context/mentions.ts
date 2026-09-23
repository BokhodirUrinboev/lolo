import { execFile } from "node:child_process";
import type { Host } from "../host/types";
import { formatDiagnostics } from "../tools/diagnostics";
import { resolveWorkspacePath } from "../tools/paths";
import { fitTokens } from "./budget";
import { listFiles } from "./repoMap";
import { fileSymbols } from "./treeSitter";

export interface SymbolLocation {
  name: string;
  path: string;
  line: number;
}

export interface ExpandedMentions {
  /** Context blocks for the task message. */
  context: string;
  /** Files the user pointed at (focus for the repo map). */
  files: string[];
}

/** `@path/to/file.ts`, `@folder/`, `@symbol:Name`, `@problems`, `@git`, `@terminal`. */
const MENTION = /(^|\s)@(symbol:[\w.$]+|problems|git|terminal|[\w./\\-]*[./\\][\w./\\-]*)/g;
const SYMBOL_CONTEXT_LINES = 30;

export function parseMentions(text: string): string[] {
  return [...text.matchAll(MENTION)].map((m) => m[2].replace(/[.,;:]+$/, ""));
}

/**
 * Expands @-mentions into context blocks within `tokens`. Unknown mentions are
 * left as plain text (the model may still find them with search).
 */
export async function expandMentions(host: Host, text: string, tokens: number, terminalOutput?: string): Promise<ExpandedMentions> {
  const blocks: string[] = [];
  const files: string[] = [];
  for (const m of new Set(parseMentions(text))) {
    if (m === "problems") {
      const d = await host.diagnostics();
      blocks.push(`@problems:\n${d.length ? formatDiagnostics(d, 60) : "No problems."}`);
    } else if (m === "git") {
      blocks.push(`@git (uncommitted diff):\n${(await gitDiff(host.root)) || "No uncommitted changes."}`);
    } else if (m === "terminal") {
      blocks.push(`@terminal (last output):\n${terminalOutput?.trim() || "(no terminal output captured)"}`);
    } else if (m.startsWith("symbol:")) {
      const name = m.slice(7);
      const locs = (await (host.workspaceSymbols ? host.workspaceSymbols(name) : findSymbols(host, name))).filter((l) => l.name === name).slice(0, 3);
      if (!locs.length) blocks.push(`@symbol:${name}: not found`);
      for (const loc of locs) {
        const lines = (await host.readFile(loc.path)).replace(/\r\n/g, "\n").split("\n");
        const from = Math.max(0, loc.line - 1);
        blocks.push(`@symbol:${name} (${loc.path}:${loc.line}):\n${lines.slice(from, from + SYMBOL_CONTEXT_LINES).join("\n")}`);
        files.push(loc.path);
      }
    } else {
      const r = resolveWorkspacePath(host.root, m);
      if ("error" in r) continue;
      const kind = await host.stat(r.path);
      if (kind === "file") {
        blocks.push(`@${r.path}:\n${await host.readFile(r.path)}`);
        files.push(r.path);
      } else if (kind === "dir") {
        const entries = await host.listDir(r.path);
        blocks.push(`@${r.path}/ (folder):\n${entries.map((e) => e.name + (e.type === "dir" ? "/" : "")).join("\n")}`);
      }
    }
  }
  // Split the budget evenly so one big file can't crowd out the rest.
  const per = blocks.length ? Math.floor(tokens / blocks.length) : 0;
  return { context: blocks.map((b) => fitTokens(b, per)).join("\n\n"), files };
}

/** Headless fallback for @symbol: definitions from tree-sitter. */
async function findSymbols(host: Host, name: string): Promise<SymbolLocation[]> {
  const out: SymbolLocation[] = [];
  const candidates = await listFiles(host);
  for (const f of candidates.slice(0, 2000)) {
    let text: string;
    try {
      text = await host.readFile(f);
    } catch {
      continue;
    }
    if (!text.includes(name)) continue;
    const s = await fileSymbols(f, text);
    for (const d of s?.defs ?? []) if (d.name === name) out.push({ name, path: f, line: d.line });
    if (out.length >= 3) break;
  }
  return out;
}

function gitDiff(cwd: string): Promise<string> {
  return new Promise((resolve) => execFile("git", ["diff", "HEAD"], { cwd, timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? "" : stdout.trim())));
}

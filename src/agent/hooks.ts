import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { Host } from "../host/types";
import { commandEnv, killTree, spawnCommand } from "../host/shell";

/**
 * Claude Code hooks (`hooks` in ~/.claude/settings.json, .claude/settings.json and
 * .claude/settings.local.json), so projects set up for Claude Code keep their checks:
 * a hook that runs the tests after `dotnet build`, one that refuses edits to generated
 * files. Same contract as Claude Code: the event as JSON on stdin; exit 0 = go on
 * (JSON on stdout may decide), exit 2 = block, with stderr as the reason for the model;
 * other exit codes are warnings for the user.
 *
 * Supported events: UserPromptSubmit (before planning; its output is context for the
 * run), PreToolUse, PostToolUse (after a successful call) and Stop (before the run ends;
 * a block adds a todo). Tools are named as in Claude Code (Bash, Read, Write, Edit, Grep,
 * LS, WebSearch, WebFetch, mcp__server__tool), so the same matchers work.
 */

export type HookEvent = "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop";
const EVENTS: HookEvent[] = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];

interface HookCommand {
  command: string;
  /** Seconds (Claude Code's default is 60). */
  timeout: number;
}

interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

export interface HookOutcome {
  /** A hook refused (exit 2, `decision: "block"`, `permissionDecision: "deny"`, `continue: false`): the reason. */
  block?: string;
  /** A PreToolUse hook approved the call (`permissionDecision: "allow"`): no approval needed. */
  allow?: boolean;
  /** Text for the model (`additionalContext`; the stdout of a UserPromptSubmit hook). */
  context: string[];
  /** Hooks that failed to run (e.g. `powershell` on Linux), for the user. */
  warnings: string[];
}

export class Hooks {
  constructor(
    private readonly groups: Map<HookEvent, HookGroup[]>,
    private readonly root: string,
  ) {}

  static empty(root = "."): Hooks {
    return new Hooks(new Map(), root);
  }

  /** Hooks of the user's and the project's Claude Code settings. */
  static async load(host: Host, userSettings = path.join(homedir(), ".claude", "settings.json")): Promise<Hooks> {
    const groups = new Map<HookEvent, HookGroup[]>();
    const texts: string[] = [];
    try {
      texts.push(readFileSync(userSettings, "utf8"));
    } catch {
      /* no user settings */
    }
    for (const f of [".claude/settings.json", ".claude/settings.local.json"]) {
      if ((await host.stat(f)) === "file") texts.push(await host.readFile(f).catch(() => ""));
    }
    for (const text of texts) {
      let hooks: unknown;
      try {
        hooks = JSON.parse(text).hooks;
      } catch {
        continue;
      }
      if (!hooks || typeof hooks !== "object") continue;
      for (const event of EVENTS) {
        const list = (hooks as Record<string, unknown>)[event];
        if (!Array.isArray(list)) continue;
        for (const g of list) {
          const cmds = (Array.isArray(g?.hooks) ? g.hooks : [])
            .filter((h: { type?: string; command?: unknown }) => (h?.type ?? "command") === "command" && typeof h?.command === "string" && h.command.trim())
            .map((h: { command: string; timeout?: unknown }) => ({ command: h.command, timeout: typeof h.timeout === "number" && h.timeout > 0 ? h.timeout : 60 }));
          if (cmds.length) groups.set(event, [...(groups.get(event) ?? []), { matcher: typeof g.matcher === "string" ? g.matcher : undefined, hooks: cmds }]);
        }
      }
    }
    return new Hooks(groups, host.root);
  }

  get size(): number {
    return [...this.groups.values()].reduce((n, g) => n + g.length, 0);
  }

  has(event: HookEvent, tool?: string): boolean {
    return this.matching(event, tool).length > 0;
  }

  private matching(event: HookEvent, tool?: string): HookCommand[] {
    const groups = this.groups.get(event) ?? [];
    return groups.filter((g) => tool === undefined || matches(g.matcher, tool)).flatMap((g) => g.hooks);
  }

  /** Runs the event's matching hooks (in order; the first block stops the rest). */
  async run(event: HookEvent, input: Record<string, unknown>, tool?: string, signal?: AbortSignal): Promise<HookOutcome> {
    const out: HookOutcome = { context: [], warnings: [] };
    const payload = JSON.stringify({ cwd: this.root, hook_event_name: event, ...input });
    for (const h of this.matching(event, tool)) {
      const r = await runHook(h, payload, this.root, signal);
      const label = `${event} hook \`${h.command.length > 80 ? h.command.slice(0, 77) + "..." : h.command}\``;
      if (r.timedOut) {
        out.warnings.push(`${label} timed out after ${h.timeout}s.`);
        continue;
      }
      if (r.code === 2) {
        out.block = (r.stderr.trim() || r.stdout.trim() || `blocked by ${label}`).slice(0, 4000);
        return out;
      }
      if (r.code !== 0) {
        const why = r.code === 127 ? "command not found" : `exit ${r.code}`;
        out.warnings.push(`${label} failed (${why})${r.stderr.trim() ? `: ${r.stderr.trim().split("\n")[0].slice(0, 200)}` : ""}.`);
        continue;
      }
      const json = parseJson(r.stdout);
      if (!json) {
        // Claude Code shows plain stdout to the model only for UserPromptSubmit.
        if (event === "UserPromptSubmit" && r.stdout.trim()) out.context.push(r.stdout.trim());
        continue;
      }
      const specific = (json.hookSpecificOutput ?? {}) as Record<string, unknown>;
      if (typeof specific.additionalContext === "string" && specific.additionalContext.trim()) out.context.push(specific.additionalContext.trim());
      const decision = specific.permissionDecision ?? json.decision;
      const reason = String(specific.permissionDecisionReason ?? json.reason ?? json.stopReason ?? "").trim();
      if (json.continue === false || decision === "block" || decision === "deny") {
        out.block = reason || `blocked by ${label}`;
        return out;
      }
      if (decision === "allow" || decision === "approve") out.allow = true;
    }
    return out;
  }
}

/** Claude Code matchers: none, "" or "*" match every tool; a plain name matches exactly; otherwise a regex ("Edit|Write", "mcp__.*"). */
export function matches(matcher: string | undefined, tool: string): boolean {
  if (!matcher || matcher === "*") return true;
  if (/^[\w-]+$/.test(matcher)) return matcher === tool;
  try {
    return new RegExp(`^(?:${matcher})$`).test(tool);
  } catch {
    return false;
  }
}

function parseJson(text: string): Record<string, unknown> | undefined {
  const t = text.trim();
  if (!t.startsWith("{")) return undefined;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" ? v : undefined;
  } catch {
    return undefined;
  }
}

function runHook(h: HookCommand, payload: string, root: string, signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const p = spawnCommand(h.command, { cwd: root, env: commandEnv({ CLAUDE_PROJECT_DIR: root }) });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const stop = () => (p.pid ? killTree(p.pid) : p.kill());
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, h.timeout * 1000);
    signal?.addEventListener("abort", stop, { once: true });
    p.stdout?.on("data", (d) => (stdout += d));
    p.stderr?.on("data", (d) => (stderr += d));
    p.stdin?.on("error", () => undefined); // the hook may exit without reading stdin
    p.stdin?.end(payload);
    const done = (code: number) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve({ code, stdout, stderr, timedOut });
    };
    p.on("error", (e) => {
      stderr += String(e);
      done(127);
    });
    p.on("close", (code) => done(code ?? 1));
  });
}

/**
 * A Lolo tool call as Claude Code names it, so matchers written for Claude Code
 * ("Bash", "Edit|Write") and scripts reading `tool_input.command`/`file_path` work.
 */
export function claudeTool(name: string, args: Record<string, unknown>, root: string, mcp?: { server: string; tool: string }): { name: string; input: Record<string, unknown> } {
  const file = (p: unknown) => (typeof p === "string" ? path.join(root, p) : undefined);
  if (mcp) return { name: `mcp__${mcp.server}__${mcp.tool}`, input: args };
  switch (name) {
    case "run_command":
    case "start_process":
      return { name: "Bash", input: { command: args.command, ...(args.cwd ? { cwd: args.cwd } : {}) } };
    case "read_file":
    case "read_symbol":
      return { name: "Read", input: { file_path: file(args.path), ...(args.start_line ? { offset: args.start_line } : {}) } };
    case "create_file":
    case "rewrite_file":
      return { name: "Write", input: { file_path: file(args.path), content: args.content } };
    case "edit":
      return { name: "Edit", input: { file_path: file(args.path), old_string: args.search, new_string: args.replace, replace_all: !!args.all } };
    case "edit_lines":
      return { name: "Edit", input: { file_path: file(args.path), old_string: "", new_string: args.content, start_line: args.start_line, end_line: args.end_line } };
    case "search":
      return { name: "Grep", input: { pattern: args.query, ...(args.path ? { path: file(args.path) } : {}) } };
    case "list_dir":
      return { name: "LS", input: { path: file(args.path ?? ".") } };
    case "web_search":
      return { name: "WebSearch", input: { query: args.query } };
    case "fetch_url":
      return { name: "WebFetch", input: { url: args.url, prompt: args.question ?? "" } };
    default:
      return { name, input: args };
  }
}

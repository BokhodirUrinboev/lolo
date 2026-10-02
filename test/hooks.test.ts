import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { claudeTool, Hooks, matches } from "../src/agent/hooks";
import { Agent } from "../src/agent/loop";
import { NodeHost } from "../src/host/nodeHost";
import { resolveProfile } from "../src/providers/modelProfiles";
import type { ChatMessage, ChatRequest, LLMProvider } from "../src/providers/types";

const NO_USER = "/nonexistent/settings.json";

/** A workspace with .claude/settings.json hooks; `scripts` go to .claude/hooks/<name>.cjs. */
function project(hooks: object, scripts: Record<string, string> = {}, files: Record<string, string> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "lolo-hooks-"));
  mkdirSync(path.join(root, ".claude", "hooks"), { recursive: true });
  writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify({ hooks }));
  for (const [n, code] of Object.entries(scripts)) writeFileSync(path.join(root, ".claude", "hooks", `${n}.cjs`), code);
  for (const [f, c] of Object.entries(files)) writeFileSync(path.join(root, f), c);
  return root;
}
const node = (name: string) => ({ type: "command", command: `node .claude/hooks/${name}.cjs` });
const READ_STDIN = `const input = JSON.parse(require("fs").readFileSync(0, "utf8"));\n`;

describe("hook matchers", () => {
  it("match like Claude Code's: all, exact names, regexes", () => {
    expect(matches(undefined, "Bash")).toBe(true);
    expect(matches("*", "Edit")).toBe(true);
    expect(matches("Bash", "Bash")).toBe(true);
    expect(matches("Bash", "BashOutput")).toBe(false);
    expect(matches("Edit|Write", "Write")).toBe(true);
    expect(matches("mcp__github__.*", "mcp__github__create_issue")).toBe(true);
  });

  it("name Lolo's tools as Claude Code does", () => {
    expect(claudeTool("run_command", { command: "dotnet build" }, "/r")).toEqual({ name: "Bash", input: { command: "dotnet build" } });
    expect(claudeTool("edit", { path: "a.cs", search: "x", replace: "y" }, "/r").input).toMatchObject({ file_path: path.join("/r", "a.cs"), old_string: "x", new_string: "y" });
    expect(claudeTool("create_file", { path: "a", content: "c" }, "/r").name).toBe("Write");
    expect(claudeTool("x", {}, "/r", { server: "jira", tool: "create" }).name).toBe("mcp__jira__create");
  });
});

describe("Hooks.run", () => {
  it("exit 2 blocks with stderr; JSON deny blocks; allow approves; exit 127 is only a warning", async () => {
    const root = project(
      {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "definitely-not-a-command-xyz" }, node("guard")] },
          { matcher: "Edit|Write", hooks: [node("files")] },
        ],
      },
      {
        guard: READ_STDIN + `if (/rm -rf/.test(input.tool_input.command)) { console.error("no rm -rf here"); process.exit(2); }
console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } }));`,
        files: READ_STDIN + `if (input.tool_input.file_path.endsWith(".g.cs")) console.log(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "generated file" } }));`,
      },
    );
    const hooks = await Hooks.load(new NodeHost(root), NO_USER);
    const rm = await hooks.run("PreToolUse", { tool_name: "Bash", tool_input: { command: "rm -rf /" } }, "Bash");
    expect(rm.block).toBe("no rm -rf here");
    expect(rm.warnings[0]).toMatch(/command not found/);
    const ls = await hooks.run("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } }, "Bash");
    expect(ls.block).toBeUndefined();
    expect(ls.allow).toBe(true);
    const gen = await hooks.run("PreToolUse", { tool_name: "Write", tool_input: { file_path: "/r/A.g.cs" } }, "Write");
    expect(gen.block).toBe("generated file");
    expect(hooks.has("PreToolUse", "Read")).toBe(false);
  });

  it("UserPromptSubmit: plain stdout and additionalContext become context", async () => {
    const root = project(
      { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo Always open a Jira task first" }, node("ctx")] }] },
      { ctx: READ_STDIN + `console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "prompt was: " + input.prompt } }));` },
    );
    const r = await (await Hooks.load(new NodeHost(root), NO_USER)).run("UserPromptSubmit", { prompt: "fix it" });
    expect(r.context).toEqual(["Always open a Jira task first", "prompt was: fix it"]);
  });
});

class Scripted implements LLMProvider {
  readonly model = "scripted";
  readonly profile = resolveProfile("qwen2.5-coder:7b");
  readonly seen: ChatMessage[][] = [];
  constructor(private readonly replies: object[]) {}
  async chat(req: ChatRequest) {
    this.seen.push(req.messages);
    const next = this.replies.shift() ?? { thought: "out of script", action: { tool: "done", args: { summary: "end" } } };
    return { content: JSON.stringify(next) };
  }
  async complete() {
    return "";
  }
}
const act = (tool: string, args: object) => ({ thought: `use ${tool}`, action: { tool, args } });
const plan = (todos: string[]) => ({ goal: "g", kind: "task", reply: "", todos });
const agent = (root: string, provider: Scripted) => new Agent({ host: new NodeHost(root, { autoApprove: true }), provider, commandAllowlist: ["echo"], trajectory: false });

describe("hooks in a run", () => {
  it("PostToolUse feedback (exit 2) reaches the model after the command", async () => {
    const root = project(
      { PostToolUse: [{ matcher: "Bash", hooks: [node("tests")] }] },
      { tests: READ_STDIN + `if (/build/.test(input.tool_input.command)) { console.error("[tests-after-build] 2 tests failed: TotalTests"); process.exit(2); }` },
    );
    const provider = new Scripted([plan(["Run `echo build`"]), act("run_command", { command: "echo build" }), act("done", { summary: "ok" })]);
    await agent(root, provider).run("run echo build", "agent");
    expect(JSON.stringify(provider.seen.at(-1))).toMatch(/PostToolUse hook reported a problem:\\n\[tests-after-build\] 2 tests failed/);
  });

  it("a PreToolUse block is refused like a policy error, and the file stays unwritten", async () => {
    const root = project({ PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "echo 'Do not create files in the root' >&2; exit 2" }] }] });
    const provider = new Scripted([plan(["Create notes.txt"]), act("create_file", { path: "notes.txt", content: "hi\n" }), act("done", { summary: "ok" })]);
    await agent(root, provider).run("create notes.txt", "agent");
    expect(JSON.stringify(provider.seen.at(-1))).toMatch(/PreToolUse hook blocked this call:\\nDo not create files in the root/);
    expect(() => readFileSync(path.join(root, "notes.txt"))).toThrow();
  });

  it("a blocking Stop hook adds a todo once; stop_hook_active tells it the run went back to work", async () => {
    const root = project(
      { Stop: [{ hooks: [node("stop")] }] },
      { stop: READ_STDIN + `if (!input.stop_hook_active) console.log(JSON.stringify({ decision: "block", reason: "CHANGELOG.md was not updated" }));` },
      { "a.txt": "x\n" },
    );
    const provider = new Scripted([
      plan(["Add a line y to a.txt"]),
      act("read_file", { path: "a.txt" }),
      act("rewrite_file", { path: "a.txt", content: "x\ny\n" }),
      act("done", { summary: "added" }),
      act("create_file", { path: "CHANGELOG.md", content: "- y\n" }),
      act("done", { summary: "changelog" }),
    ]);
    const r = await agent(root, provider).run("add y to a.txt", "agent");
    expect(r.status).toBe("done");
    expect(r.todos).toEqual(["Add a line y to a.txt", "Fix what the project's Stop hook reported: CHANGELOG.md was not updated"]);
    expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toBe("- y\n");
  });

  it("a blocking UserPromptSubmit hook cancels the run before planning", async () => {
    const root = project({ UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo 'Open a Jira task first' >&2; exit 2" }] }] });
    const provider = new Scripted([plan(["x"])]);
    const r = await agent(root, provider).run("fix the bug", "agent");
    expect(r.status).toBe("cancelled");
    expect(r.summary).toMatch(/Open a Jira task first/);
    expect(provider.seen).toHaveLength(0);
  });
});

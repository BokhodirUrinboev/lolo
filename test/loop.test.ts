import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent/loop";
import { NodeHost } from "../src/host/nodeHost";
import { resolveProfile } from "../src/providers/modelProfiles";
import type { ChatMessage, ChatRequest, LLMProvider } from "../src/providers/types";

/** A model that replies from a script, in order, and records what it was sent. */
class Scripted implements LLMProvider {
  readonly model = "scripted";
  readonly profile = resolveProfile("qwen2.5-coder:7b");
  readonly seen: ChatMessage[][] = [];
  constructor(private readonly replies: (string | object)[]) {}
  async chat(req: ChatRequest) {
    this.seen.push(req.messages);
    const next = this.replies.shift() ?? { thought: "out of script", action: { tool: "done", args: { summary: "end" } } };
    return { content: typeof next === "string" ? next : JSON.stringify(next) };
  }
  async complete() {
    return "";
  }
}

const act = (tool: string, args: object) => ({ thought: `use ${tool}`, action: { tool, args } });
const plan = (todos: string[]) => ({ goal: "g", kind: "task", reply: "", todos });

function workspace(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "lolo-loop-"));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), c);
  }
  return { root, read: (f: string) => readFileSync(path.join(root, f), "utf8") };
}

const run = (root: string, provider: Scripted, task: string) =>
  new Agent({ host: new NodeHost(root, { autoApprove: true }), provider, commandAllowlist: [], trajectory: false }).run(task, "agent");

describe("agent loop", () => {
  it("stops an identical edit that was already applied instead of repeating it forever", async () => {
    const { root, read } = workspace({ "a.txt": "one\n" });
    const append = act("edit", { path: "a.txt", search: "one", replace: "one\ntwo" });
    const provider = new Scripted([plan(["Add a line two after one in a.txt"]), append, append, append, append, append]);
    const r = await run(root, provider, "Add a line two after one in a.txt");
    expect(read("a.txt")).toBe("one\ntwo\n");
    expect(r.status).toBe("failed"); // stuck: nobody to ask in a headless run
    expect(JSON.stringify(provider.seen.at(-1))).toMatch(/already made exactly this change/);
  });

  it("reminds the model to act after five reads in a row", async () => {
    const { root } = workspace({ "a.txt": "x\n", "b.txt": "y\n" });
    const reads = [act("read_file", { path: "a.txt" }), act("read_file", { path: "b.txt" }), act("list_dir", {}), act("search", { query: "x" }), act("search", { query: "y" })];
    const provider = new Scripted([plan(["Look around"]), ...reads, act("done", { summary: "ok" })]);
    await run(root, provider, "Look around and change nothing");
    expect(JSON.stringify(provider.seen.at(-1))).toMatch(/5 reads in a row/);
  });

  it("asks the planner again when it put code lines into the todos", async () => {
    const { root } = workspace({ "a.txt": "x\n" });
    const provider = new Scripted([
      plan(["Create IClock.cs with:", "```csharp", "public interface IClock", "{", "}", "```"]),
      plan(["Create IClock.cs with an interface IClock", "Make SystemClock implement IClock"]),
      act("done", { summary: "a" }),
      act("done", { summary: "b" }),
    ]);
    const r = await run(root, provider, "Add IClock");
    expect(r.todos).toEqual(["Create IClock.cs with an interface IClock", "Make SystemClock implement IClock"]);
    expect(JSON.stringify(provider.seen[1])).toMatch(/contain lines of code/);
  });

  it("keeps existing tests read-only when the task is to make failing tests pass", async () => {
    const { root, read } = workspace({ "src/a.js": "exports.two = () => 3;\n", "test/a.test.js": "// expects 2\n" });
    const provider = new Scripted([
      plan(["Fix src/a.js so the tests pass"]),
      act("edit", { path: "test/a.test.js", search: "// expects 2", replace: "// expects 3" }),
      act("edit", { path: "src/a.js", search: "() => 3", replace: "() => 2" }),
      act("done", { summary: "fixed" }),
    ]);
    const r = await run(root, provider, "The tests fail. Fix the code so the tests pass.");
    expect(read("test/a.test.js")).toBe("// expects 2\n");
    expect(read("src/a.js")).toBe("exports.two = () => 2;\n");
    expect(r.status).toBe("done");
    expect(JSON.stringify(provider.seen[2])).toMatch(/is a test/);
  });
});

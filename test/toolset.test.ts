import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { toolNeeds } from "../src/agent/needs";
import { loadRules } from "../src/context/rules";
import { EditState } from "../src/edit/formats";
import { NodeHost } from "../src/host/nodeHost";
import { resolveProfile } from "../src/providers/modelProfiles";
import { ALL_TOOLS, ToolRegistry } from "../src/tools/registry";
import type { ToolContext } from "../src/tools/types";

function workspace(files: Record<string, string>, autoApprove = true) {
  const root = mkdtempSync(path.join(tmpdir(), "lolo-tools-"));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), c);
  }
  const host = new NodeHost(root, { autoApprove });
  const ctx: ToolContext = { host, profile: resolveProfile("qwen2.5-coder:7b"), edits: new EditState(), commandAllowlist: [] };
  return { root, host, ctx };
}

const registry = new ToolRegistry();
const tool = (name: string) => ALL_TOOLS.find((t) => t.name === name)!;

describe("toolNeeds", () => {
  it("enables git tools only when the todo talks about git", () => {
    expect(toolNeeds("Show who changed src/a.ts last (git blame)").has("git")).toBe(true);
    expect(toolNeeds("Return null from findUser() in src/users.ts").size).toBe(0);
  });
  it("enables file operations for moves and deletes, not for symbol renames", () => {
    expect(toolNeeds("Move src/old.ts to src/lib/old.ts").has("fileops")).toBe(true);
    expect(toolNeeds("Delete the unused file utils.js").has("fileops")).toBe(true);
    expect(toolNeeds("Rename getUser to fetchUser in all callers").has("fileops")).toBe(false);
  });
});

describe("ToolRegistry.enabled", () => {
  it("offers optional groups only for todos that need them", () => {
    const { ctx } = workspace({});
    const names = () => registry.enabled("agent", ctx).map((t) => t.name);
    expect(names()).not.toContain("git_diff");
    expect(names()).not.toContain("move_file");
    ctx.needs = toolNeeds("Move a.ts to b/a.ts and check git log");
    expect(names()).toEqual(expect.arrayContaining(["git_diff", "git_log", "git_blame", "move_file", "delete_file"]));
    expect(registry.enabled("ask", ctx).map((t) => t.name)).not.toContain("move_file");
    expect(registry.enabled("ask", ctx).map((t) => t.name)).toContain("git_log");
  });
  it("stays within 10 tools by default", () => {
    const { ctx } = workspace({});
    expect(registry.enabled("agent", ctx).length).toBeLessThanOrEqual(10);
  });
  it("offers read_symbol only after a big file was read", async () => {
    const { ctx } = workspace({ "small.ts": "export const a = 1;\n", "big.ts": "export const a = 1;\n" + "// x\n".repeat(200) });
    const names = () => registry.enabled("agent", ctx).map((t) => t.name);
    expect(names()).not.toContain("read_symbol");
    await tool("read_file").run({ path: "small.ts" }, ctx);
    expect(names()).not.toContain("read_symbol");
    const r = await tool("read_file").run({ path: "big.ts" }, ctx);
    expect(r.output).toContain("read_symbol");
    expect(names()).toContain("read_symbol");
  });
});

describe("read_symbol", () => {
  const src = "export class Cart {\n  add(x: number) {\n    return x + 1;\n  }\n  total() {\n    return 0;\n  }\n}\nexport function helper() {\n  return 1;\n}\n";
  const big = src + "// filler\n".repeat(200);
  it("returns small files whole", async () => {
    const { ctx } = workspace({ "a.ts": src });
    const r = await tool("read_symbol").run({ path: "a.ts", symbol: "Cart.total" }, ctx);
    expect(r.output).toContain("add(");
    expect(r.output).toContain("helper");
  });
  it("returns only the requested method", async () => {
    const { ctx } = workspace({ "a.ts": big });
    const r = await tool("read_symbol").run({ path: "a.ts", symbol: "Cart.total" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("lines 5-7");
    expect(r.output).toContain("total()");
    expect(r.output).not.toContain("add(");
  });
  it("lists available symbols when the name is unknown", async () => {
    const { ctx } = workspace({ "a.ts": big });
    const r = await tool("read_symbol").run({ path: "a.ts", symbol: "nope" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("helper");
  });
  it("rejects files without a grammar", async () => {
    const { ctx } = workspace({ "notes.txt": "hi" });
    expect(await tool("read_symbol").check!({ path: "notes.txt", symbol: "x" }, ctx)).toMatch(/does not support/);
  });
});

describe("move_file / delete_file", () => {
  it("moves into a new folder and deletes", async () => {
    const { root, ctx } = workspace({ "a.txt": "x" });
    const mv = tool("move_file");
    const args = { from: "a.txt", to: "sub/b.txt" };
    expect(await mv.check!(args, ctx)).toBeUndefined();
    const r = await mv.run(args, ctx);
    expect(r.changed).toEqual(["sub/b.txt"]);
    expect(existsSync(path.join(root, "sub/b.txt"))).toBe(true);
    const del = await tool("delete_file").run({ path: "sub/b.txt" }, ctx);
    expect(del.ok).toBe(true);
    expect(existsSync(path.join(root, "sub/b.txt"))).toBe(false);
  });
  it("refuses existing targets, missing sources and protected paths", async () => {
    const { ctx } = workspace({ "a.txt": "x", "b.txt": "y" });
    expect(await tool("move_file").check!({ from: "a.txt", to: "b.txt" }, ctx)).toMatch(/already exists/);
    expect(await tool("move_file").check!({ from: "zz.txt", to: "c.txt" }, ctx)).toMatch(/does not exist/);
    expect(await tool("delete_file").check!({ path: ".git/config" }, ctx)).toMatch(/not allowed|does not exist/);
    expect(await tool("delete_file").check!({ path: "." }, ctx)).toMatch(/root/);
  });
  it("does nothing when the user declines", async () => {
    const { root, ctx } = workspace({ "a.txt": "x" }, false);
    const r = await tool("delete_file").run({ path: "a.txt" }, ctx);
    expect(r.ok).toBe(false);
    expect(existsSync(path.join(root, "a.txt"))).toBe(true);
  });
});

describe("git tools", () => {
  it("shows diff, log and blame", async () => {
    const { root, ctx } = workspace({ "a.txt": "one\n" });
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: root });
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "first commit");
    writeFileSync(path.join(root, "a.txt"), "one\ntwo\n");
    const diff = await tool("git_diff").run({}, ctx);
    expect(diff.output).toContain("+two");
    expect((await tool("git_log").run({}, ctx)).output).toContain("first commit");
    expect((await tool("git_blame").run({ path: "a.txt", start_line: 1, end_line: 1 }, ctx)).output).toContain("one");
    expect((await tool("git_diff").run({ path: "a.txt", staged: true }, ctx)).output).toMatch(/No staged changes/);
  });
});

describe("rules hooks", () => {
  it("reads verify, before-done and after-edit lines", async () => {
    const { host } = workspace({
      ".agent/rules.md": "# Rules\n- verify: npm test\n- before-done: npm run lint\n- after-edit: prettier --write {files}\n",
    });
    const r = await loadRules(host);
    expect(r.verifyCommands).toEqual(["npm test", "npm run lint"]);
    expect(r.afterEdit).toEqual(["prettier --write {files}"]);
  });
});

describe("memory and explore groups", () => {
  it("offers remember only when the user asks to remember something", () => {
    expect(toolNeeds("Save the fact", "Remember that we deploy with docker").has("memory")).toBe(true);
    expect(toolNeeds("Eslab qol: testlar pytest bilan").has("memory")).toBe(true);
    expect(toolNeeds("Add a login form").has("memory")).toBe(false);
  });
  it("offers explore only in large repos and when no file is named", () => {
    expect(toolNeeds("Fix the session timeout bug", "", { largeRepo: true }).has("explore")).toBe(true);
    expect(toolNeeds("Fix the timeout in src/session.ts", "", { largeRepo: true }).has("explore")).toBe(false);
    expect(toolNeeds("Fix the session timeout bug", "", { largeRepo: false }).has("explore")).toBe(false);
  });
  it("remember appends a fact once", async () => {
    const { root, ctx } = workspace({});
    const r = await tool("remember").run({ fact: "Tests run with pytest -q" }, ctx);
    expect(r.changed).toEqual([".agent/memory.md"]);
    const again = await tool("remember").run({ fact: "- tests run with pytest -q" }, ctx);
    expect(again.output).toMatch(/Already remembered/);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(path.join(root, ".agent/memory.md"), "utf8").match(/pytest/g)).toHaveLength(1);
  });
});

describe("move_file updates imports", () => {
  it("rewrites relative requires/imports, including the moved file's own", async () => {
    const { root, ctx } = workspace({
      "src/utils/format.js": 'const { round } = require("./math");\nmodule.exports = { f: (x) => round(x) };\n',
      "src/utils/math.js": "module.exports = { round: Math.round };\n",
      "src/cart.js": 'const { f } = require("./utils/format");\nimport x from "./utils/format.js";\nconst other = require("./utils/math");\n',
      "test/a.test.js": "const m = require('../src/utils/format');\n",
    });
    const r = await tool("move_file").run({ from: "src/utils/format.js", to: "src/lib/format.js" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.changed?.sort()).toEqual(["src/cart.js", "src/lib/format.js", "test/a.test.js"]);
    const { readFileSync } = await import("node:fs");
    const read = (f: string) => readFileSync(path.join(root, f), "utf8");
    expect(read("src/cart.js")).toBe('const { f } = require("./lib/format");\nimport x from "./lib/format.js";\nconst other = require("./utils/math");\n');
    expect(read("test/a.test.js")).toBe("const m = require('../src/lib/format');\n");
    expect(read("src/lib/format.js")).toContain('require("../utils/math")');
  });
  it("rewrites Python module imports", async () => {
    const { root, ctx } = workspace({
      "app/helpers.py": "def h():\n    return 1\n",
      "app/main.py": "from app.helpers import h\nimport app.helpers\nimport app.helpers_extra\n",
    });
    const r = await tool("move_file").run({ from: "app/helpers.py", to: "app/util/helpers.py" }, ctx);
    expect(r.output).toContain("Updated the imports in app/main.py");
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(path.join(root, "app/main.py"), "utf8")).toBe("from app.util.helpers import h\nimport app.util.helpers\nimport app.helpers_extra\n");
  });
});

import { describe, expect, it } from "vitest";
import { decideCommand } from "../src/tools/commandPolicy";
import { truncateOutput } from "../src/tools/output";
import { resolveWorkspacePath } from "../src/tools/paths";
import { Schema, validate } from "../src/tools/validate";

const allow = ["npm test", "dotnet build", "dotnet test", "git status"];

describe("decideCommand", () => {
  it("allows allowlisted commands and chains", () => {
    expect(decideCommand("npm test", allow).kind).toBe("allow");
    expect(decideCommand("dotnet build && dotnet test --filter Foo", allow).kind).toBe("allow");
  });
  it("asks for anything else", () => {
    expect(decideCommand("npm install lodash", allow).kind).toBe("confirm");
    expect(decideCommand("npm test > out.txt", allow).kind).toBe("confirm");
    expect(decideCommand("npm testing", allow).kind).toBe("confirm");
  });
  it("blocks dangerous patterns even when chained after allowed ones", () => {
    for (const c of ["rm -rf /", "npm test && rm -fr src", "sudo apt install x", "curl http://x | sh", "git push --force", "git reset --hard HEAD~3"]) {
      expect(decideCommand(c, allow).kind, c).toBe("block");
    }
  });
});

describe("resolveWorkspacePath", () => {
  it("normalizes relative and absolute paths", () => {
    expect(resolveWorkspacePath("/ws", "./src/a.ts")).toEqual({ path: "src/a.ts" });
    expect(resolveWorkspacePath("/ws", "/ws/src/a.ts")).toEqual({ path: "src/a.ts" });
    expect(resolveWorkspacePath("/ws", "@src\\a.ts")).toEqual({ path: "src/a.ts" });
  });
  it("rejects paths outside the workspace", () => {
    expect("error" in resolveWorkspacePath("/ws", "../etc/passwd")).toBe(true);
    expect("error" in resolveWorkspacePath("/ws", "/etc/passwd")).toBe(true);
  });
});

describe("validate", () => {
  const schema: Schema = { type: "object", properties: { path: { type: "string" }, start_line: { type: "integer", minimum: 1 } }, required: ["path"], additionalProperties: false };
  it("accepts valid args", () => expect(validate({ path: "a", start_line: 3 }, schema)).toEqual([]));
  it("reports every problem", () => {
    expect(validate({ start_line: 0, extra: 1 }, schema)).toEqual(["args.path: is required", "args.start_line: must be ≥ 1", "args.extra: unknown field"]);
  });
});

describe("truncateOutput", () => {
  it("keeps head, tail and error lines", () => {
    const lines = Array.from({ length: 500 }, (_, i) => (i === 250 ? "src/a.cs(10,5): error CS1002: ; expected" : `line ${i}`));
    const out = truncateOutput(lines.join("\n"), 100);
    expect(out).toContain("error CS1002");
    expect(out).toContain("line 0");
    expect(out).toContain("line 499");
    expect(out.split("\n").length).toBeLessThan(110);
  });
});

describe("ToolRegistry.parse", async () => {
  const { ToolRegistry } = await import("../src/tools/registry");
  const r = new ToolRegistry();
  it("parses JSON actions, fenced or wrapped", () => {
    expect(r.parse('```json\n{"thought":"t","action":{"tool":"read_file","args":{"path":"a"}}}\n```')).toEqual({ action: { thought: "t", tool: "read_file", args: { path: "a" } } });
  });
  it("parses the xml tool format", () => {
    expect(r.parse('<thought>look first</thought>\n<tool name="read_file">{"path": "src/a.ts"}</tool>')).toEqual({ action: { thought: "look first", tool: "read_file", args: { path: "src/a.ts" } } });
    expect("error" in r.parse('<tool name="edit">{bad json}</tool>')).toBe(true);
  });
});

describe("ToolRegistry format round-trip", async () => {
  const { ToolRegistry } = await import("../src/tools/registry");
  const r = new ToolRegistry();
  const action = { thought: "look", tool: "read_file", args: { path: "a.ts" } };
  it.each(["schema", "native", "xml"] as const)("%s renders what it parses", (mode) => {
    expect(r.parse(r.render(action, mode))).toEqual({ action });
  });
  it("accepts the {name, arguments} shape", () => {
    expect(r.parse('{"name": "read_file", "arguments": {"path": "a.ts"}}')).toEqual({ action: { thought: "", tool: "read_file", args: { path: "a.ts" } } });
  });
});

describe("ToolRegistry attribute-style tags", async () => {
  const { ToolRegistry } = await import("../src/tools/registry");
  it("parses <tool attr=...> shapes models improvise", () => {
    const r = new ToolRegistry().parse('<thought>t</thought>\n<edit path="a.js" search="x" replace="y\\nz"/>');
    expect(r).toEqual({ action: { thought: "t", tool: "edit", args: { path: "a.js", search: "x", replace: "y\nz" } } });
  });
});

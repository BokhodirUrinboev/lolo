import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expandMentions } from "../src/context/mentions";
import { EditState } from "../src/edit/formats";
import { NodeHost } from "../src/host/nodeHost";
import { loadMcpConfig, McpHub } from "../src/mcp/hub";
import { sanitizeSchema } from "../src/mcp/schema";
import { selectMcpTools } from "../src/mcp/select";
import { resolveProfile } from "../src/providers/modelProfiles";
import { ToolRegistry } from "../src/tools/registry";
import type { ToolContext } from "../src/tools/types";

const FIXTURE = path.join(__dirname, "fixtures", "mcp-server.cjs");

describe("sanitizeSchema", () => {
  it("inlines refs, merges allOf, turns nullable into optional and drops unsupported keywords", () => {
    const s = sanitizeSchema({
      type: "object",
      $defs: { Id: { type: "string", pattern: "^[a-z]+$", format: "uuid" } },
      properties: {
        id: { $ref: "#/$defs/Id" },
        when: { type: ["string", "null"], format: "date-time" },
        kind: { oneOf: [{ const: "a" }, { const: "b" }] },
        opts: { allOf: [{ type: "object", properties: { x: { type: "integer" } } }, { properties: { y: { type: "boolean" } }, required: ["y"] }] },
        self: { $ref: "#/$defs/Missing" },
      },
      required: ["id", "ghost"],
      additionalProperties: false,
    });
    expect(s.properties!.id).toEqual({ type: "string" });
    expect(s.properties!.when).toEqual({ type: "string" });
    expect(s.properties!.kind).toEqual({ anyOf: [{ const: "a" }, { const: "b" }] });
    expect(s.properties!.opts.properties).toEqual({ x: { type: "integer" }, y: { type: "boolean" } });
    expect(s.properties!.self).toEqual({});
    expect(s.required).toEqual(["id"]);
  });
});

describe("McpHub", () => {
  let root: string;
  let hub: McpHub;
  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "lolo-mcp-"));
    mkdirSync(path.join(root, ".agent"));
    writeFileSync(
      path.join(root, ".agent/mcp.json"),
      JSON.stringify({ mcpServers: { notes: { command: "node", args: [FIXTURE] }, broken: { command: "definitely-not-a-command-xyz" }, off: { command: "node", disabled: true } } }),
    );
    hub = new McpHub(loadMcpConfig(root), root);
    await hub.ready();
  }, 30_000);
  afterAll(() => hub.close());

  it("connects, lists tools/resources/prompts and reports broken servers", () => {
    const st = Object.fromEntries(hub.status().map((s) => [s.name, s]));
    expect(st.notes.ok).toBe(true);
    expect(st.notes.tools).toBe(2);
    expect(st.broken.ok).toBe(false);
    expect(st.off).toBeUndefined();
    expect(hub.tools().map((t) => t.name).sort()).toEqual(["mcp__notes__list_notes", "mcp__notes__save_note"]);
    expect(hub.resources()[0]).toMatchObject({ server: "notes", name: "readme", uri: "notes://readme" });
    expect(hub.prompts()[0]).toMatchObject({ server: "notes", name: "summarize", args: ["topic"] });
  });

  it("maps tools to ToolDefs: read-only hint, sanitized params, descriptions", () => {
    const list = hub.tools().find((t) => t.mcp.tool === "list_notes")!;
    const save = hub.tools().find((t) => t.mcp.tool === "save_note")!;
    expect(list.kind).toBe("read");
    expect(save.kind).toBe("exec");
    expect(save.params.properties!.tag).toMatchObject({ enum: ["todo", "idea"] });
    expect(save.params.properties!.priority).toMatchObject({ type: "integer", minimum: 1, maximum: 3 });
    expect(save.params.required).toEqual(["text"]);
    expect(new ToolRegistry(hub.tools()).describe([list])).toContain("tag: Only notes with this tag");
  });

  it("calls tools: approval for writes, errors reported, read-only without asking", async () => {
    const asked: string[] = [];
    const host = new NodeHost(root, { confirm: async (m) => (asked.push(m), true) });
    const ctx: ToolContext = { host, profile: resolveProfile("qwen2.5-coder:7b"), edits: new EditState(), commandAllowlist: [] };
    const save = hub.tools().find((t) => t.mcp.tool === "save_note")!;
    const list = hub.tools().find((t) => t.mcp.tool === "list_notes")!;
    expect((await save.run({ text: "buy milk", tag: "todo" }, ctx)).output).toBe('saved "buy milk"');
    expect(asked[0]).toContain("notes.save_note");
    const bad = await save.run({ text: "fail" }, ctx);
    expect(bad.ok).toBe(false);
    expect(bad.output).toContain("cannot save that");
    expect((await list.run({ tag: "todo" }, ctx)).output).toBe("- buy milk");
    expect(asked).toHaveLength(2);
  });

  it("offers tools by relevance or by @mcp:<server>", () => {
    const tools = hub.tools();
    expect([...selectMcpTools(tools, "Save a note that the build is broken")]).toContain("mcp__notes__save_note");
    expect(selectMcpTools(tools, "Fix the null check in src/users.ts").size).toBe(0);
    expect(selectMcpTools(tools, "Do it", "@mcp:notes check everything").size).toBe(2);
    const ctx = { mcpTools: selectMcpTools(tools, "list my notes") } as ToolContext;
    const reg = new ToolRegistry(tools);
    const names = reg.enabled("ask", { ...ctx, profile: resolveProfile("qwen2.5-coder:7b"), edits: new EditState() } as ToolContext).map((t) => t.name);
    expect(names).toContain("mcp__notes__list_notes");
    expect(names).not.toContain("mcp__notes__save_note");
  });

  it("expands @mcp:server/resource mentions and renders prompts", async () => {
    const r = await expandMentions(new NodeHost(root), "see @mcp:notes/readme please", 2000, { mcp: hub });
    expect(r.context).toContain("Notes are kept in memory.");
    expect(await hub.getPrompt("notes", "summarize", "caching")).toBe("Summarize everything about caching.");
  });
});

describe("Agent Lolo as an MCP server", () => {
  it("serves repo_map, edit and rename to an MCP client", async () => {
    const { execFileSync } = await import("node:child_process");
    const { existsSync, readFileSync } = await import("node:fs");
    const cli = path.join(__dirname, "..", "dist", "cli.js");
    if (!existsSync(cli)) execFileSync(process.execPath, ["esbuild.mjs"], { cwd: path.join(__dirname, "..") });
    const root = mkdtempSync(path.join(tmpdir(), "lolo-srv-"));
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src/a.js"), "function calcTotal(xs) {\n    return xs.reduce((s, x) => s + x, 0);\n}\nmodule.exports = { calcTotal };\n");
    writeFileSync(path.join(root, "src/b.js"), "const { calcTotal } = require('./a');\nconsole.log(calcTotal([1, 2]));\n");
    const hub = new McpHub({ lolo: { command: "node", args: [cli, "--mcp-server", "--root", root] } }, root);
    await hub.ready();
    try {
      expect(hub.status()[0]).toMatchObject({ ok: true });
      const names = hub.tools().map((t) => t.mcp.tool);
      expect(names).toEqual(expect.arrayContaining(["repo_map", "edit", "rename_symbol", "find_references"]));
      const host = new NodeHost(root, { autoApprove: true, confirm: async () => true });
      const ctx: ToolContext = { host, profile: resolveProfile("qwen2.5-coder:7b"), edits: new EditState(), commandAllowlist: [] };
      const call = (tool: string, args: Record<string, unknown>) => hub.tools().find((t) => t.mcp.tool === tool)!.run(args, ctx);
      expect((await call("repo_map", {})).output).toContain("calcTotal");
      // Fuzzy: wrong indentation in `search` still applies.
      const e = await call("edit", { path: "src/a.js", search: "  return xs.reduce((s, x) => s + x, 0);", replace: "  return xs.reduce((s, x) => s + x, 0) * 2;" });
      expect(e.ok).toBe(true);
      expect(readFileSync(path.join(root, "src/a.js"), "utf8")).toContain("    return xs.reduce((s, x) => s + x, 0) * 2;");
      const r = await call("rename_symbol", { symbol: "calcTotal", new_name: "sum" });
      expect(r.ok).toBe(true);
      expect(readFileSync(path.join(root, "src/b.js"), "utf8")).toContain("const { sum } = require('./a');");
    } finally {
      await hub.close();
    }
  }, 60_000);
});

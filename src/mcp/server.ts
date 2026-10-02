import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildRepoMap } from "../context/repoMap";
import { EditState } from "../edit/formats";
import { NodeHost } from "../host/nodeHost";
import { resolveProfile } from "../providers/modelProfiles";
import { editFile, readSymbol } from "../tools/fileTools";
import { ToolRegistry } from "../tools/registry";
import { findDefinition, findReferences, renameSymbol } from "../tools/symbolTools";
import type { ToolContext, ToolDef } from "../tools/types";

/**
 * Agent Lolo as an MCP server (`node dist/cli.js --mcp-server --root <dir>`): other
 * agents get its tree-sitter repo map, the forgiving edit engine (fuzzy match,
 * re-indent, syntax guard) and code-based renames. No model is involved; edits are
 * written directly, so the calling agent is responsible for approval.
 */

const EXPOSED: ToolDef[] = [editFile, readSymbol, findDefinition, findReferences, renameSymbol];

const REPO_MAP = {
  name: "repo_map",
  description: "Files and their main symbols (classes, functions, signatures), ranked by relevance to `focus` files and identifiers in `task`, within a token budget.",
  inputSchema: {
    type: "object",
    properties: {
      focus: { type: "array", items: { type: "string" }, description: "Workspace-relative files to rank first" },
      task: { type: "string", description: "What you are working on; identifiers in it raise matching symbols" },
      tokens: { type: "integer", minimum: 200, maximum: 20000, description: "Budget (default 2000)" },
    },
  },
};

export async function serveMcp(root: string): Promise<void> {
  const host = new NodeHost(root, { autoApprove: true });
  // A generous profile: the edit tools accept any format a capable caller sends.
  const profile = { ...resolveProfile("qwen3-coder"), wholeFileMaxLines: 100_000 };
  const ctx: ToolContext = { host, profile, edits: new EditState(), commandAllowlist: [] };
  const registry = new ToolRegistry();

  const server = new Server({ name: "agent-lolo", version: "0.6.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      REPO_MAP,
      ...EXPOSED.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.params,
        annotations: { readOnlyHint: t.kind === "read" },
      })),
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    if (req.params.name === REPO_MAP.name) {
      const map = await buildRepoMap(host, Number(args.tokens ?? 2000), (args.focus as string[]) ?? [], String(args.task ?? ""));
      return { content: [{ type: "text", text: map || "(no supported source files)" }] };
    }
    const checked = await registry.check({ thought: "", tool: req.params.name, args }, EXPOSED, ctx);
    if (!checked.ok) return { isError: true, content: [{ type: "text", text: checked.error }] };
    const r = await checked.tool.run(checked.args, ctx);
    return { isError: !r.ok, content: [{ type: "text", text: r.output }] };
  });
  await server.connect(new StdioServerTransport());
}

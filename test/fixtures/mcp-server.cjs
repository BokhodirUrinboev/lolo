// Minimal MCP server for tests: two tools, a resource and a prompt, over stdio.
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

const server = new McpServer({ name: "notes", version: "1.0.0" });
const notes = [];
server.registerTool(
  "list_notes",
  { description: "List the saved notes.", inputSchema: { tag: z.string().optional().describe("Only notes with this tag") }, annotations: { readOnlyHint: true } },
  async ({ tag }) => ({ content: [{ type: "text", text: notes.filter((n) => !tag || n.tag === tag).map((n) => `- ${n.text}`).join("\n") || "no notes" }] }),
);
server.registerTool(
  "save_note",
  { description: "Save a note with an optional tag.", inputSchema: { text: z.string().min(1), tag: z.enum(["todo", "idea"]).optional(), priority: z.number().int().min(1).max(3).nullable().optional() } },
  async ({ text, tag }) => {
    if (text === "fail") return { isError: true, content: [{ type: "text", text: "cannot save that" }] };
    notes.push({ text, tag });
    return { content: [{ type: "text", text: `saved "${text}"` }] };
  },
);
server.registerResource("readme", "notes://readme", { description: "How notes work" }, async (uri) => ({ contents: [{ uri: uri.href, text: "Notes are kept in memory." }] }));
server.registerPrompt("summarize", { description: "Summarize a topic", argsSchema: { topic: z.string() } }, ({ topic }) => ({
  messages: [{ role: "user", content: { type: "text", text: `Summarize everything about ${topic}.` } }],
}));
server.connect(new StdioServerTransport());

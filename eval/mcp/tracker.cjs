// Mock issue tracker MCP server for eval tasks. Tickets created with create_ticket are
// written to $TRACKER_STATE (JSON) so the task's check can see them.
const { writeFileSync, mkdirSync } = require("node:fs");
const path = require("node:path");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

const ISSUES = {
  41: { title: "Typo in the README", body: "The README says 'recieve'." },
  42: {
    title: "Wrong VAT rate",
    body: "priceWithVat(net) in src/vat.js still uses the old 20% VAT rate. Since January 2026 the rate is 15%. The result must also be rounded to 2 decimals (cents), e.g. priceWithVat(9.99) is 11.49.",
  },
};
const tickets = [];
const save = () => {
  if (!process.env.TRACKER_STATE) return;
  mkdirSync(path.dirname(process.env.TRACKER_STATE), { recursive: true });
  writeFileSync(process.env.TRACKER_STATE, JSON.stringify({ tickets }, null, 2));
};

const server = new McpServer({ name: "tracker", version: "1.0.0" });
server.registerTool(
  "get_issue",
  { description: "Get an issue of the tracker by its number: title and description.", inputSchema: { id: z.number().int().describe("Issue number") }, annotations: { readOnlyHint: true } },
  async ({ id }) => {
    const i = ISSUES[id];
    return i ? { content: [{ type: "text", text: `#${id} ${i.title}\n\n${i.body}` }] } : { isError: true, content: [{ type: "text", text: `No issue #${id}.` }] };
  },
);
server.registerTool(
  "list_issues",
  { description: "List the open issues of the tracker.", inputSchema: {}, annotations: { readOnlyHint: true } },
  async () => ({ content: [{ type: "text", text: Object.entries(ISSUES).map(([id, i]) => `#${id} ${i.title}`).join("\n") }] }),
);
server.registerTool(
  "create_ticket",
  { description: "Create a new ticket in the tracker.", inputSchema: { title: z.string().min(3), file: z.string().optional().describe("The file the ticket is about") } },
  async ({ title, file }) => {
    tickets.push({ title, file });
    save();
    return { content: [{ type: "text", text: `Created ticket #${100 + tickets.length}: ${title}` }] };
  },
);
server.connect(new StdioServerTransport());

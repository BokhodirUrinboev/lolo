import type { McpToolDef } from "./hub";

/**
 * Which MCP tools a todo gets, without the model: a server can bring dozens of
 * tools, and every one in the action schema is another wrong choice for a small
 * model. `@mcp:<server>` (or the server's name) in the message offers that
 * server's tools; otherwise tools whose name/description share words with the todo.
 */

const MAX_TOOLS = 4;
const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "file", "files", "code", "use", "using", "add", "make", "get", "set", "all", "new", "then", "when", "your", "you", "are", "was", "not", "can", "will", "should", "must", "does", "each", "any"]);

function words(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map((w) => w.replace(/(ies|es|s)$/, (m) => (m === "ies" ? "y" : "")));
}

export function selectMcpTools(tools: McpToolDef[], todo: string, message = ""): Set<string> {
  const text = `${todo}\n${message}`;
  const asked = new Set([...text.matchAll(/@mcp:([\w-]+)/g)].map((m) => m[1]));
  const want = new Set(words(text));
  const scored = tools.map((t) => {
    const server = t.mcp.server;
    let score = asked.has(server) || new RegExp(`\\b${server.replace(/[^\w-]/g, "")}\\b`, "i").test(text) ? 10 : 0;
    const nameWords = new Set(words(t.mcp.tool));
    const descWords = new Set(words(t.mcp.text));
    for (const w of want) score += nameWords.has(w) ? 2 : descWords.has(w) ? 1 : 0;
    return { name: t.name, score };
  });
  return new Set(
    scored
      .filter((s) => s.score >= 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, asked.size ? MAX_TOOLS + 2 : MAX_TOOLS)
      .map((s) => s.name),
  );
}

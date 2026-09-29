import type { Host } from "../host/types";
import type { McpHub } from "../mcp/hub";

/**
 * User slash commands: `.agent/commands/<name>.md` (a prompt template; `$ARGUMENTS`
 * is replaced by what follows the command) and MCP server prompts (`/<server>:<prompt>`).
 * Expanded into the message before the agent sees it.
 */

export interface SlashCommand {
  /** Without the slash: "review" or "github:summarize". */
  name: string;
  description: string;
}

export const COMMANDS_DIR = ".agent/commands";

interface FileCommand extends SlashCommand {
  template: string;
}

async function fileCommands(host: Host): Promise<FileCommand[]> {
  if ((await host.stat(COMMANDS_DIR)) !== "dir") return [];
  const out: FileCommand[] = [];
  for (const e of (await host.listDir(COMMANDS_DIR)).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.type !== "file" || !e.name.endsWith(".md")) continue;
    const raw = (await host.readFile(`${COMMANDS_DIR}/${e.name}`).catch(() => "")).replace(/\r\n/g, "\n");
    // Optional front matter: `description: ...`
    const fm = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
    const template = (fm ? raw.slice(fm[0].length) : raw).trim();
    const description = /^description:\s*(.+)$/m.exec(fm?.[1] ?? "")?.[1]?.trim() ?? template.split("\n")[0].replace(/^#+\s*/, "").slice(0, 80);
    out.push({ name: e.name.slice(0, -3).toLowerCase().replace(/[^\w-]+/g, "-"), description, template });
  }
  return out;
}

export async function listSlashCommands(host: Host, mcp?: McpHub): Promise<SlashCommand[]> {
  const files = (await fileCommands(host)).map(({ name, description }) => ({ name, description }));
  const prompts = (mcp?.prompts() ?? []).map((p) => ({ name: `${p.server}:${p.name}`, description: p.description ?? `MCP prompt from ${p.server}` }));
  return [...files, ...prompts];
}

/** The message with a leading `/command args` expanded; undefined when it isn't a user command. */
export async function expandSlashCommand(text: string, host: Host, mcp?: McpHub): Promise<string | undefined> {
  const m = /^\/([\w-]+(?::[\w.-]+)?)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return undefined;
  const [, name, args = ""] = m;
  if (name.includes(":")) {
    const [server, prompt] = name.split(":");
    if (!mcp) return undefined;
    await mcp.ready();
    return mcp.getPrompt(server, prompt, args.trim());
  }
  const cmd = (await fileCommands(host)).find((c) => c.name === name.toLowerCase());
  if (!cmd) return undefined;
  return cmd.template.includes("$ARGUMENTS") ? cmd.template.replace(/\$ARGUMENTS/g, args.trim()) : [cmd.template, args.trim()].filter(Boolean).join("\n\n");
}

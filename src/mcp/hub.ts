import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { disabledMcpServers } from "../context/claudeSetup";
import { truncateOutput } from "../tools/output";
import { fail, ok, ToolContext, ToolDef } from "../tools/types";
import { sanitizeSchema, shorten } from "./schema";

/**
 * MCP client side: connects to the configured servers (stdio or streamable HTTP)
 * and turns their tools into ToolDefs. Tools only reach the model when a todo is
 * about them (see select.ts); calls need approval unless the server marks the
 * tool read-only.
 */

export interface McpServerConfig {
  /** stdio servers */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** HTTP servers (streamable HTTP) */
  url?: string;
  headers?: Record<string, string>;
  /** Tools to offer (names); all when absent. */
  tools?: string[];
  disabled?: boolean;
}

export const MCP_CONFIG_PATH = ".agent/mcp.json";

const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 12_000;

export interface McpToolDef extends ToolDef {
  mcp: { server: string; tool: string; readOnly: boolean; text: string };
}

interface Server {
  name: string;
  config: McpServerConfig;
  client?: Client;
  error?: string;
  tools: McpToolDef[];
  resources: { name: string; uri: string; description?: string }[];
  prompts: { name: string; description?: string; args: string[] }[];
}

function readServers(file: string): Record<string, McpServerConfig> {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return j.mcpServers ?? j.servers ?? {};
  } catch {
    return {}; // missing or invalid
  }
}

/**
 * Servers from, lowest priority first: `inherited` (VS Code's own `mcp.servers` setting),
 * `.vscode/mcp.json`, `.agent/mcp.json` ({"mcpServers": {...}} as in Claude/Cursor, or
 * {"servers": {...}} as in VS Code), then `extra` (the extension setting).
 * `${env:NAME}` and `${workspaceFolder}` expand; servers needing `${input:...}` are skipped.
 */
export function loadMcpConfig(
  root: string,
  extra: Record<string, McpServerConfig> = {},
  inherited: Record<string, McpServerConfig> = {},
): Record<string, McpServerConfig> {
  const all: Record<string, McpServerConfig> = {
    ...inherited,
    ...readServers(path.join(root, ".vscode", "mcp.json")),
    ...readServers(path.join(root, ".mcp.json")), // Claude Code's project servers
    ...readServers(path.join(root, MCP_CONFIG_PATH)),
    ...extra,
  };
  for (const name of disabledMcpServers(root)) delete all[name];
  const expand = (v: string) =>
    v.replace(/\$\{workspaceFolder\}/g, root).replace(/\$\{env:(\w+)\}/g, (_, n: string) => process.env[n] ?? "");
  const out: Record<string, McpServerConfig> = {};
  for (const [name, c] of Object.entries(all)) {
    if (!c || c.disabled || (!c.command && !c.url)) continue;
    if (JSON.stringify(c).includes("${input:")) continue; // VS Code prompts for these; we can't
    out[name] = {
      ...c,
      command: c.command && expand(c.command),
      args: c.args?.map(expand),
      cwd: c.cwd && expand(c.cwd),
      url: c.url && expand(c.url),
      env: c.env && Object.fromEntries(Object.entries(c.env).map(([k, v]) => [k, expand(String(v))])),
      headers: c.headers && Object.fromEntries(Object.entries(c.headers).map(([k, v]) => [k, expand(String(v))])),
    };
  }
  return out;
}

export function configKey(configs: Record<string, McpServerConfig>): string {
  return createHash("sha1").update(JSON.stringify(configs)).digest("hex");
}

/** Tool names the model sees: `mcp__<server>__<tool>`, only [A-Za-z0-9_]. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`.replace(/[^\w]/g, "_").slice(0, 64);
}

export class McpHub {
  private servers: Server[];
  private started?: Promise<void>;

  constructor(configs: Record<string, McpServerConfig>, private readonly root: string, private readonly log: (msg: string) => void = () => undefined) {
    this.servers = Object.entries(configs).map(([name, config]) => ({ name, config, tools: [], resources: [], prompts: [] }));
  }

  get size() {
    return this.servers.length;
  }

  /** Connects every server once (in parallel); failures are recorded, not thrown. */
  ready(): Promise<void> {
    this.started ??= Promise.all(this.servers.map((s) => this.connect(s))).then(() => undefined);
    return this.started;
  }

  /** Tools the user switched off in the /mcp menu, by ToolDef name (`mcp__server__tool`). */
  disabled = new Set<string>();

  status(): { name: string; ok: boolean; tools: number; error?: string }[] {
    return this.servers.map((s) => ({ name: s.name, ok: !!s.client, tools: s.tools.length, error: s.error }));
  }

  /** Tools offered to the agent. */
  tools(): McpToolDef[] {
    return this.allTools().filter((t) => !this.disabled.has(t.name));
  }

  /** Every tool of the connected servers, including switched-off ones (for the /mcp menu). */
  allTools(): McpToolDef[] {
    return this.servers.flatMap((s) => s.tools);
  }

  resources() {
    return this.servers.flatMap((s) => s.resources.map((r) => ({ server: s.name, ...r })));
  }

  prompts() {
    return this.servers.flatMap((s) => s.prompts.map((p) => ({ server: s.name, ...p })));
  }

  /** A resource by name or URI, as text. */
  async readResource(server: string, nameOrUri: string): Promise<string | undefined> {
    const s = this.servers.find((x) => x.name === server);
    if (!s?.client) return undefined;
    const r = s.resources.find((x) => x.name === nameOrUri || x.uri === nameOrUri || x.name.replace(/\s+/g, "-") === nameOrUri);
    const res = await s.client.readResource({ uri: r?.uri ?? nameOrUri });
    return res.contents.map((c) => ("text" in c && typeof c.text === "string" ? c.text : `[binary ${c.mimeType ?? "data"}: ${c.uri}]`)).join("\n\n");
  }

  /** An MCP prompt rendered as one message; `input` fills the first argument. */
  async getPrompt(server: string, name: string, input: string): Promise<string | undefined> {
    const s = this.servers.find((x) => x.name === server);
    const p = s?.prompts.find((x) => x.name === name);
    if (!s?.client || !p) return undefined;
    const args: Record<string, string> = {};
    if (p.args[0] && input) args[p.args[0]] = input;
    const res = await s.client.getPrompt({ name, arguments: args });
    return res.messages.map((m) => (m.content.type === "text" ? m.content.text : `[${m.content.type}]`)).join("\n\n");
  }

  async close(): Promise<void> {
    await Promise.all(this.servers.map((s) => s.client?.close().catch(() => undefined)));
    for (const s of this.servers) s.client = undefined;
  }

  private async connect(s: Server): Promise<void> {
    const c = s.config;
    try {
      const client = new Client({ name: "agent-lolo", version: "0.5.3" });
      const transport = c.url
        ? new StreamableHTTPClientTransport(new URL(c.url), { requestInit: { headers: c.headers } })
        : new StdioClientTransport({
            command: c.command!,
            args: c.args,
            env: { ...getDefaultEnvironment(), ...c.env },
            cwd: c.cwd ? path.resolve(this.root, c.cwd) : this.root,
            stderr: "pipe",
          });
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
      s.client = client;
      const caps = client.getServerCapabilities() ?? {};
      if (caps.tools) {
        const listed = await listAll((cursor) => client.listTools({ cursor }), (r) => r.tools);
        s.tools = listed.filter((t) => !c.tools || c.tools.includes(t.name)).map((t) => this.toolDef(s, t));
      }
      if (caps.resources) {
        const listed = await listAll((cursor) => client.listResources({ cursor }), (r) => r.resources).catch(() => []);
        s.resources = listed.map((r) => ({ name: r.name, uri: r.uri, description: r.description }));
      }
      if (caps.prompts) {
        const listed = await listAll((cursor) => client.listPrompts({ cursor }), (r) => r.prompts).catch(() => []);
        s.prompts = listed.map((p) => ({ name: p.name, description: p.description, args: (p.arguments ?? []).map((a) => a.name) }));
      }
      this.log(`MCP ${s.name}: ${s.tools.length} tools, ${s.resources.length} resources, ${s.prompts.length} prompts`);
    } catch (e) {
      s.error = (e as Error).message;
      this.log(`MCP ${s.name}: failed to start (${s.error})`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toolDef(s: Server, t: any): McpToolDef {
    const readOnly = t.annotations?.readOnlyHint === true;
    const description = shorten(t.description || t.title || t.name, 200);
    const name = mcpToolName(s.name, t.name);
    const hub = this;
    return {
      name,
      kind: readOnly ? "read" : "exec",
      group: "mcp",
      description: `[MCP ${s.name}] ${description}`,
      params: sanitizeSchema(t.inputSchema),
      mcp: { server: s.name, tool: t.name, readOnly, text: `${s.name} ${t.name} ${t.title ?? ""} ${t.description ?? ""}` },
      async run(args: Record<string, unknown>, ctx: ToolContext) {
        if (!readOnly) {
          const preview = shorten(JSON.stringify(args), 300);
          const approval = ctx.host.approveCommand
            ? await ctx.host.approveCommand(`mcp ${s.name}.${t.name} ${preview}`, `calls the "${t.name}" tool of the MCP server "${s.name}"`)
            : { ok: await ctx.host.confirm(`Call MCP tool ${s.name}.${t.name} ${preview}?`) };
          if (!approval.ok) {
            const why = approval.feedback ? ` They said: ${approval.feedback}` : "";
            return fail(`The user declined this MCP call.${why} Don't guess its result: if the task needs it, call done and say what is missing.`, `${name}: declined`);
          }
        }
        return hub.call(s, t.name, args, ctx.signal);
      },
    };
  }

  private async call(s: Server, tool: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const label = `${s.name}.${tool}`;
    if (!s.client) return fail(`MCP server ${s.name} is not connected${s.error ? `: ${s.error}` : ""}.`, `${label}: not connected`);
    try {
      const res = await s.client.callTool({ name: tool, arguments: args }, undefined, { signal, timeout: CALL_TIMEOUT_MS });
      const text = contentText(res);
      const out = text.length > MAX_OUTPUT_CHARS ? truncateOutput(text, 200).slice(0, MAX_OUTPUT_CHARS) + "\n[output cut]" : text;
      const first = (text.split("\n").find((l) => l.trim()) ?? "").slice(0, 100);
      return res.isError ? fail(`MCP tool error: ${out}`, `${label}: error: ${first}`) : ok(out || "(no output)", `${label}: ${first || "ok"}`);
    } catch (e) {
      return fail(`MCP call failed: ${(e as Error).message}`, `${label}: failed`);
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function contentText(res: any): string {
  const parts: string[] = [];
  for (const c of res.content ?? []) {
    if (c.type === "text") parts.push(c.text);
    else if (c.type === "image" || c.type === "audio") parts.push(`[${c.type} ${c.mimeType}, ${Math.round((c.data?.length ?? 0) * 0.75)} bytes; not shown]`);
    else if (c.type === "resource") parts.push(typeof c.resource?.text === "string" ? c.resource.text : `[resource ${c.resource?.uri}]`);
    else if (c.type === "resource_link") parts.push(`[resource ${c.name ?? ""} ${c.uri}]`);
  }
  if (!parts.length && res.structuredContent !== undefined) parts.push(JSON.stringify(res.structuredContent, null, 1));
  return parts.join("\n\n").trim();
}

async function listAll<R extends { nextCursor?: string }, T>(page: (cursor?: string) => Promise<R>, items: (r: R) => T[]): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const r = await page(cursor);
    out.push(...items(r));
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  return out;
}

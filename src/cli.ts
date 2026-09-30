/**
 * Headless agent: `node dist/cli.js [options] "task"`. Used for manual testing
 * and by the eval runner. Edits are auto-approved (a checkpoint is taken first).
 */
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { Agent, AgentEvent, RunOptions, RunResult } from "./agent/loop";
import { expandSlashCommand } from "./context/slashCommands";
import { Checkpoints } from "./edit/checkpoints";
import { NodeHost } from "./host/nodeHost";
import { loadMcpConfig, McpHub } from "./mcp/hub";
import { serveMcp } from "./mcp/server";
import { createProvider } from "./providers";
import type { ModelProfile } from "./providers/modelProfiles";
import type { AgentMode } from "./tools/registry";
import type { Turn } from "./ui/protocol";
import { applyEvent, conversationText, pendingPlanFor } from "./ui/transcript";
import type { WebConfig, WebProvider } from "./web/search";

const c = { dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", reset: "\x1b[0m" };
const DEFAULT_ALLOWLIST = ["dotnet build", "dotnet test", "npm test", "npm run build", "npm run lint", "npx tsc", "node --test", "git status", "git diff", "git log", "ls", "cat", "pwd"];

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: "string", default: process.cwd() },
    mode: { type: "string", default: "agent" },
    model: { type: "string", default: "qwen2.5-coder-32k:latest" },
    provider: { type: "string", default: "ollama" },
    endpoint: { type: "string", default: "http://localhost:11434" },
    "tool-mode": { type: "string" },
    "api-key": { type: "string", default: "" },
    "max-steps": { type: "string", default: "15" },
    "embed-model": { type: "string" },
    web: { type: "string" },
    "searxng-url": { type: "string" },
    yes: { type: "boolean", short: "y", default: false },
    json: { type: "boolean", default: false },
    checkpoints: { type: "boolean", default: false },
    chat: { type: "boolean", default: false },
    restore: { type: "string" },
    "mcp-server": { type: "boolean", default: false },
  },
});

async function checkpointCommand() {
  const cp = new Checkpoints(values.root!);
  if (!values.restore) {
    for (const x of await cp.list()) console.log(`${x.id.slice(0, 8)}  ${x.time.toISOString()}  ${x.label}`);
    return;
  }
  const target = (await cp.list(500)).find((x) => x.id.startsWith(values.restore!));
  if (!target) throw new Error(`no checkpoint ${values.restore}`);
  await cp.restore(target.id);
  console.log(`restored to ${target.id.slice(0, 8)} (${target.label}); the previous state is saved as "before restore to ${target.id.slice(0, 8)}"`);
}

if (values["mcp-server"]) {
  // stdout carries the MCP protocol: nothing else may print there.
  serveMcp(path.resolve(values.root!)).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
} else if (values.checkpoints || values.restore) {
  checkpointCommand().then(
    () => process.exit(0),
    (e) => {
      console.error(e.message);
      process.exit(1);
    },
  );
} else {
  main();
}

function main() {
  const task = positionals.join(" ").trim();
  if (values.chat) {
    void chat();
    return;
  }
  if (!task) {
    console.error('usage: cli [--root DIR] [--mode agent|ask|plan] [--model ID] [--provider ollama|openai] [--endpoint URL] [--tool-mode schema|native|xml] [--embed-model ID] [--web searxng|brave|tavily|duckduckgo] [-y] [--json] "task"\n       cli [--root DIR] --checkpoints | --restore <id>\n       cli [--root DIR] --mcp-server   (Agent Lolo tools over MCP stdio)');
    process.exit(2);
  }

  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stderr }) : undefined;
  const ask = async (q: string) => (rl ? (await rl.question(`${c.yellow}? ${q}${c.reset}\n> `)).trim() : undefined);

  const host = new NodeHost(values.root!, {
    autoApprove: true,
    interactive: !values.yes && !!rl,
    confirm: async (m) => values.yes || (await ask(`${m} [y/N]`))?.toLowerCase() === "y",
    askUser: async (q) => (values.yes ? undefined : ask(q)),
  });
  const abort = new AbortController();
  process.on("SIGINT", () => abort.abort());

  const mcp = mcpHub(values.root!);
  const agent = new Agent({ host, provider: makeProvider(), commandAllowlist: DEFAULT_ALLOWLIST, onEvent: print, maxStepsPerTodo: Number(values["max-steps"]), embeddingModel: values["embed-model"], web: webConfig(), mcp });
  agent.run(task, values.mode as AgentMode, abort.signal).then(async (r) => {
    rl?.close();
    await mcp?.close();
    if (values.json) console.log(JSON.stringify(r));
    else printResult(r);
    process.exit(r.status === "done" || r.status === "planned" ? 0 : 1);
  });
}

/**
 * `--chat`: a conversation like Claude Code's terminal. Each line is a message;
 * earlier turns are passed to the next run. `/ask`, `/plan`, `/agent` prefix a
 * message with a mode; `/run` executes the last plan; `/new` clears; `/exit`.
 */
async function chat() {
  const host = new NodeHost(values.root!, { autoApprove: true, interactive: false, confirm: async () => !!values.yes });
  const mcp = mcpHub(values.root!);
  const agent = (onEvent: (e: AgentEvent) => void) =>
    new Agent({ host, provider: makeProvider(), commandAllowlist: DEFAULT_ALLOWLIST, onEvent, maxStepsPerTodo: Number(values["max-steps"]), embeddingModel: values["embed-model"], web: webConfig(), mcp });
  let turns: Turn[] = [];
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: !!process.stdin.isTTY });
  const prompt = () => process.stdin.isTTY && process.stderr.write(`${c.cyan}> ${c.reset}`);
  prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) {
      prompt();
      continue;
    }
    if (line === "/exit") break;
    if (line === "/new") {
      turns = [];
      console.log(`${c.dim}(new conversation)${c.reset}`);
      prompt();
      continue;
    }
    let mode = values.mode as AgentMode;
    let text = line;
    let plan: RunOptions["plan"];
    const m = /^\/(ask|plan|agent)\s+([\s\S]+)/.exec(line);
    if (m) [mode, text] = [m[1] as AgentMode, m[2]];
    else if (line.startsWith("/") && line !== "/run") {
      const expanded = await expandSlashCommand(line, host, mcp);
      if (expanded === undefined) {
        console.log(`${c.red}unknown command${c.reset} (user commands are .md files in .agent/commands)`);
        prompt();
        continue;
      }
      text = expanded;
    }
    if (line === "/run") {
      const last = [...turns].reverse().flatMap((t) => t.items).find((i) => i.kind === "plan");
      if (last?.kind !== "plan") {
        console.log(`${c.yellow}no plan to run${c.reset}`);
        prompt();
        continue;
      }
      [mode, text, plan] = ["agent", "Run the plan.", { goal: last.goal, todos: last.todos }];
    }
    if (!plan && mode !== "ask") {
      plan = pendingPlanFor(turns, text);
      if (plan) mode = "agent";
    }
    if (!process.stdin.isTTY) console.log(`${c.cyan}> ${line}${c.reset}`);
    const turn: Turn = { id: String(Date.now()), items: [{ kind: "user", text, mode }], running: true };
    const conversation = conversationText(turns);
    const abort = new AbortController();
    const onSigint = () => abort.abort();
    process.on("SIGINT", onSigint);
    const r = await agent((e) => {
      print(e);
      applyEvent(turn, e);
    }).run(text, mode, abort.signal, { conversation, plan });
    process.off("SIGINT", onSigint);
    turn.running = false;
    turns.push(turn);
    printResult(r);
    prompt();
  }
  rl.close();
  await mcp?.close();
}


function makeProvider() {
  const toolMode = values["tool-mode"] as ModelProfile["toolMode"] | undefined;
  return createProvider({
    provider: values.provider as "ollama" | "openai",
    endpoint: values.endpoint!,
    apiKey: values["api-key"],
    model: values.model!,
    profiles: toolMode ? [{ match: values.model!, toolMode }] : [],
  });
}

/** MCP servers from .agent/mcp.json / .vscode/mcp.json, if any. */
function mcpHub(root: string): McpHub | undefined {
  const configs = loadMcpConfig(path.resolve(root));
  return Object.keys(configs).length ? new McpHub(configs, path.resolve(root), (m) => console.error(`${c.dim}${m}${c.reset}`)) : undefined;
}

/** `--web <provider>`; Brave/Tavily keys come from LOLO_WEB_API_KEY. */
function webConfig(): WebConfig | undefined {
  if (!values.web) return undefined;
  return { provider: values.web as WebProvider, searxngUrl: values["searxng-url"], apiKey: process.env.LOLO_WEB_API_KEY };
}

function printResult(r: RunResult) {
  const color = r.status === "done" || r.status === "planned" ? c.green : c.red;
  console.log(`\n${color}${r.status}${c.reset}\n${r.summary}`);
  if (r.changed.length) console.log(`${c.dim}changed: ${r.changed.join(", ")}${c.reset}`);
  const s = r.stats;
  console.log(`${c.dim}steps ${s.steps} · tool calls ${s.toolCalls} (${s.invalidCalls} invalid${s.refusedCalls ? `, ${s.refusedCalls} refused` : ""}) · edits ${s.editsApplied}/${s.editCalls} · ${(s.ms / 1000).toFixed(1)}s${r.checkpoint ? ` · checkpoint ${r.checkpoint.slice(0, 8)}` : ""}${c.reset}\n`);
}

function print(e: AgentEvent) {
  const out = process.stderr;
  switch (e.type) {
    case "status": return out.write(`${c.dim}… ${e.text}${c.reset}\n`);
    case "checkpoint": return out.write(`${c.dim}checkpoint ${e.id.slice(0, 8)}${c.reset}\n`);
    case "plan": return out.write(`${e.goal ? `${c.dim}Goal: ${e.goal}${c.reset}\n` : ""}${c.cyan}Plan:${c.reset}\n${e.todos.map((t, i) => `  ${i + 1}. ${t}`).join("\n")}\n`);
    case "todo": return e.status === "active" ? out.write(`${c.cyan}▶ todo ${e.index + 1}${c.reset}\n`) : out.write(`${e.status === "done" ? c.green + "✔" : c.red + "✘"} todo ${e.index + 1}${c.reset}\n`);
    case "thought": return out.write(`${c.dim}  💭 ${e.text}${c.reset}\n`);
    case "tool": return out.write(`  ${e.result.ok ? c.green + "●" : c.red + "●"}${c.reset} ${e.result.summary}\n`);
    case "invalid": return out.write(`  ${c.yellow}⚠ ${e.error}${c.reset}\n`);
    case "verify": return out.write(`  ${e.ok ? c.green + "verify ok" : c.red + "verify failed"}${c.reset}\n${e.ok ? "" : c.dim + e.output.split("\n").slice(0, 8).join("\n") + c.reset + "\n"}`);
    case "tokens": return out.write(`${c.dim}  [${e.prompt}+${e.output} tok / ${e.ctx}]${c.reset}\n`);
    case "error": return out.write(`${c.red}error: ${e.message}${c.reset}\n`);
    case "done":
    case "streaming":
      return;
  }
}



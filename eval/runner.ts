/**
 * Eval harness: `node dist/eval.js run [--filter x] [--model m] [--runs n]` and
 * `node dist/eval.js export [--out file] <results dirs...>`.
 *
 * A task is a folder in eval/tasks/<id>/ with
 *   task.json  { "task": "...", "check": "<command>", "mode"?: "agent" }
 *   repo/      starting workspace (copied to a temp dir per run)
 *   check/     hidden files copied over the workspace AFTER the agent finishes
 *              (tests the agent must not see or edit); then `check` must exit 0.
 */
import { execSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { Agent, RunResult } from "../src/agent/loop";
import { NodeHost } from "../src/host/nodeHost";
import { createProvider } from "../src/providers";
import type { ModelProfile } from "../src/providers/modelProfiles";
import type { AgentMode } from "../src/tools/registry";

interface TaskSpec {
  task: string;
  check: string;
  mode?: AgentMode;
  allow?: string[];
}

interface TaskResult {
  id: string;
  run: number;
  pass: boolean;
  status: RunResult["status"];
  steps: number;
  modelCalls: number;
  invalidCalls: number;
  editCalls: number;
  editsApplied: number;
  ms: number;
  checkOutput: string;
}

const ALLOW = ["node --test", "npm test", "dotnet build", "dotnet test", "dotnet run", "python3 -m unittest", "python -m unittest", "go test", "go build", "go vet", "ls", "cat", "git status", "git diff"];

async function run(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      tasks: { type: "string", default: path.join(process.cwd(), "eval", "tasks") },
      out: { type: "string", default: path.join(process.cwd(), "eval", "results") },
      filter: { type: "string", default: "" },
      model: { type: "string", default: "qwen2.5-coder-32k:latest" },
      provider: { type: "string", default: "ollama" },
      endpoint: { type: "string", default: "http://localhost:11434" },
      "tool-mode": { type: "string" },
      runs: { type: "string", default: "1" },
      "max-steps": { type: "string", default: "15" },
      "embed-model": { type: "string" },
    },
  });
  const ids = readdirSync(values.tasks!)
    .filter((d) => existsSync(path.join(values.tasks!, d, "task.json")) && d.includes(values.filter!))
    .sort();
  if (!ids.length) throw new Error(`no tasks in ${values.tasks} matching "${values.filter}"`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(values.out!, stamp);
  mkdirSync(path.join(outDir, "trajectories"), { recursive: true });
  const toolMode = values["tool-mode"] as ModelProfile["toolMode"] | undefined;
  const provider = createProvider({
    provider: values.provider as "ollama" | "openai",
    endpoint: values.endpoint!,
    model: values.model!,
    profiles: toolMode ? [{ match: values.model!, toolMode }] : [],
  });
  const results: TaskResult[] = [];

  for (const id of ids) {
    for (let r = 0; r < Number(values.runs); r++) {
      const dir = path.join(values.tasks!, id);
      const spec = JSON.parse(readFileSync(path.join(dir, "task.json"), "utf8")) as TaskSpec;
      const ws = mkdtempSync(path.join(tmpdir(), `eval-${id}-`));
      cpSync(path.join(dir, "repo"), ws, { recursive: true });
      execSync("git init -q && git add -A && git -c user.name=eval -c user.email=eval@localhost commit -qm start", { cwd: ws });

      process.stderr.write(`▶ ${id}${Number(values.runs) > 1 ? ` #${r + 1}` : ""} … `);
      const agent = new Agent({
        host: new NodeHost(ws, { autoApprove: true, interactive: false }),
        provider,
        commandAllowlist: [...ALLOW, ...(spec.allow ?? [])],
        maxStepsPerTodo: Number(values["max-steps"]),
        embeddingModel: values["embed-model"],
      });
      const res = await agent.run(spec.task, spec.mode ?? "agent");

      if (existsSync(path.join(dir, "check"))) cpSync(path.join(dir, "check"), ws, { recursive: true });
      const check = spawnSync(spec.check, { cwd: ws, shell: true, encoding: "utf8", timeout: 5 * 60_000 });
      const pass = check.status === 0;
      const s = res.stats;
      results.push({
        id, run: r, pass, status: res.status, steps: s.steps, modelCalls: s.modelCalls, invalidCalls: s.invalidCalls,
        editCalls: s.editCalls, editsApplied: s.editsApplied, ms: s.ms, checkOutput: (check.stdout + check.stderr).slice(-2000),
      });
      if (res.logFile) cpSync(res.logFile, path.join(outDir, "trajectories", `${id}-${r}${pass ? "-pass" : "-fail"}.jsonl`));
      process.stderr.write(`${pass ? "PASS" : "FAIL"} (${res.status}, ${s.steps} steps, ${(s.ms / 1000).toFixed(0)}s)\n`);
    }
  }

  const summary = aggregate(results);
  writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ model: values.model, toolMode: provider.profile.toolMode, summary, results }, null, 2));
  const previous = previousSummary(values.out!, stamp);
  console.log(`\n${table(summary, previous)}\n\nresults: ${outDir}`);
}

export function aggregate(rs: TaskResult[]) {
  const sum = (f: (r: TaskResult) => number) => rs.reduce((a, r) => a + f(r), 0);
  const pct = (a: number, b: number) => (b ? Math.round((1000 * a) / b) / 10 : 100);
  return {
    tasks: rs.length,
    toolCallValidity: pct(sum((r) => r.modelCalls - r.invalidCalls), sum((r) => r.modelCalls)),
    editApply: pct(sum((r) => r.editsApplied), sum((r) => r.editCalls)),
    taskPass: pct(rs.filter((r) => r.pass).length, rs.length),
    avgSteps: Math.round((10 * sum((r) => r.steps)) / Math.max(1, rs.length)) / 10,
    avgSeconds: Math.round(sum((r) => r.ms) / Math.max(1, rs.length) / 100) / 10,
  };
}

type Summary = ReturnType<typeof aggregate>;

function previousSummary(outRoot: string, current: string): Summary | undefined {
  const dirs = readdirSync(outRoot).filter((d) => d < current && existsSync(path.join(outRoot, d, "results.json"))).sort();
  const last = dirs[dirs.length - 1];
  return last ? JSON.parse(readFileSync(path.join(outRoot, last, "results.json"), "utf8")).summary : undefined;
}

function table(s: Summary, prev?: Summary): string {
  const rows: [string, keyof Summary, string, string][] = [
    ["tool-call validity", "toolCallValidity", "%", "≥ 98%"],
    ["edit apply", "editApply", "%", "≥ 95%"],
    ["task pass", "taskPass", "%", "≥ 60%"],
    ["avg steps", "avgSteps", "", ""],
    ["avg time", "avgSeconds", "s", ""],
  ];
  const lines = [`metric               value     Δ prev    target`, `-------------------  --------  --------  ------`];
  for (const [label, key, unit, target] of rows) {
    const v = s[key];
    const d = prev ? Math.round((v - prev[key]) * 10) / 10 : undefined;
    lines.push(`${label.padEnd(19)}  ${`${v}${unit}`.padEnd(8)}  ${(d === undefined ? "" : `${d > 0 ? "+" : ""}${d}`).padEnd(8)}  ${target}`);
  }
  return `${s.tasks} runs\n${lines.join("\n")}`;
}

/**
 * Turns trajectories into chat-format fine-tuning samples: one sample per model
 * call whose reply was a valid action, from passing runs only (by default).
 */
function exportDataset(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { out: { type: "string", default: "dataset.jsonl" }, "include-failed": { type: "boolean", default: false } },
  });
  const files = positionals.flatMap((p) => {
    const dir = existsSync(path.join(p, "trajectories")) ? path.join(p, "trajectories") : p;
    return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f));
  });
  const out: string[] = [];
  for (const file of files) {
    if (!values["include-failed"] && file.endsWith("-fail.jsonl")) continue;
    const events = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    if (events.find((e) => e.type === "run_end")?.status !== "done") continue;
    let messages: { role: string; content: string }[] = [];
    events.forEach((e, i) => {
      if (e.type !== "llm") return;
      messages = [...messages.slice(0, e.from), ...e.messages];
      const next = events.slice(i + 1).find((x) => x.type !== "compaction");
      if (next && (next.type === "invalid" || next.type === "stuck")) return;
      out.push(JSON.stringify({ messages: [...messages, { role: "assistant", content: e.response }] }));
    });
  }
  writeFileSync(values.out!, out.join("\n") + (out.length ? "\n" : ""));
  console.log(`${out.length} samples from ${files.length} trajectories → ${values.out}`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "run") {
  run(rest).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
} else if (cmd === "export") {
  exportDataset(rest);
} else {
  console.error("usage: eval run [--filter id] [--model m] [--runs n] | eval export [--out dataset.jsonl] <results dir...>");
  process.exit(2);
}

import { decideCommand } from "./commandPolicy";
import { truncateOutput } from "./output";
import { resolveWorkspacePath } from "./paths";
import { startProcess } from "./processes";
import { failureReport } from "./testReport";
import { fail, ok, ToolContext, ToolDef } from "./types";

export const runCommand: ToolDef<{ command: string; cwd?: string }> = {
  name: "run_command",
  kind: "exec",
  description:
    "Run a shell command (build, test, lint, project generators) and get its exit code and output. `cwd`: folder relative to the workspace root (default: root). " +
    "Commands are stopped after 2 minutes: never start servers or watchers (dotnet run, npm start, npm run dev).",
  params: { type: "object", properties: { command: { type: "string", minLength: 1 }, cwd: { type: "string" } }, required: ["command"] },
  async check(a, ctx) {
    if (a.cwd === undefined) return undefined;
    const r = resolveWorkspacePath(ctx.host.root, a.cwd);
    if ("error" in r) return r.error;
    if ((await ctx.host.stat(r.path)) !== "dir") return `cwd "${a.cwd}" is not a folder in the workspace.`;
    a.cwd = r.path;
    return undefined;
  },
  async run(a, ctx) {
    const server = await serverReason(a.command, a.cwd ?? ".", ctx);
    if (server) {
      // The todo may really need the server running (e.g. "check the endpoint with curl"): offer start_process.
      const bg = ctx.processes ? ` If the task needs it running (to call it with curl), use start_process instead: ${startProcess.description.split(". ")[0]}.` : "";
      if (ctx.processes) (ctx.needs ??= new Set()).add("process");
      return fail(`Not run: ${server}${bg}`, `run_command "${a.command}": refused (server)`);
    }
    const decision = decideCommand(a.command, ctx.commandAllowlist);
    if (decision.kind === "block") return fail(`Command blocked (${decision.reason}). Do not retry it.`, `run_command "${a.command}": blocked`);
    if (decision.kind === "confirm") {
      const approval = ctx.host.approveCommand
        ? await ctx.host.approveCommand(a.command, decision.reason)
        : { ok: await ctx.host.confirm(`Run \`${a.command}\`? (${decision.reason})`) };
      if (!approval.ok) {
        const why = approval.feedback ? ` They said: ${approval.feedback}` : "";
        return fail(`The user declined to run this command.${why}`, `run_command "${a.command}": declined`);
      }
    }
    const r = await ctx.host.runCommand(a.command, ctx.signal, { cwd: a.cwd });
    const out = r.exitCode === 0 ? truncateOutput(r.output) : failureReport(r.output, ctx.host.root);
    const where = a.cwd && a.cwd !== "." ? ` (in ${a.cwd})` : "";
    const timeout = r.timedOut
      ? "\n[Timed out after 2 minutes and was stopped. Servers and watchers never finish; check your work with a build or tests instead.]"
      : "";
    const text = `$ ${a.command}${where}\nexit code ${r.exitCode}\n${out}${timeout}`;
    const summary = `run_command "${a.command}"${where}: ${r.timedOut ? "timed out" : `exit ${r.exitCode}`}`;
    return r.exitCode === 0 ? ok(text, summary) : { ok: false, output: text, summary };
  },
};

const SERVER_COMMANDS: [RegExp, string][] = [
  [/\bdotnet\s+watch\b/, "dotnet build"],
  [/\bnpm\s+(start|run\s+(dev|serve|start|watch))\b|\b(yarn|pnpm)\s+(dev|start|serve)\b|\b(vite|nodemon|next\s+dev)\b/, "npm run build (or npm test)"],
  [/\b(uvicorn|gunicorn|flask\s+run|manage\.py\s+runserver|rails\s+s(erver)?)\b/, "the tests or a syntax/import check"],
];

/**
 * Commands that start a server or watcher never exit, so they only burn the
 * timeout. `dotnet run` is refused only for web projects (console apps are fine).
 */
async function serverReason(command: string, cwd: string, ctx: ToolContext): Promise<string | undefined> {
  for (const [re, instead] of SERVER_COMMANDS) {
    if (re.test(command)) return `\`${command}\` starts a server/watcher that never exits. Check your work with ${instead} instead.`;
  }
  if (!/\bdotnet\s+run\b/.test(command)) return undefined;
  const project = /--project\s+("[^"]+"|\S+)/.exec(command)?.[1]?.replace(/"/g, "");
  const candidates = project
    ? [project.endsWith("proj") ? project : `${project}`]
    : (await ctx.host.listDir(cwd).catch(() => [])).filter((e) => e.type === "file" && /\.csproj$/.test(e.name)).map((e) => `${cwd}/${e.name}`);
  for (const c of candidates) {
    const file = c.endsWith("proj") ? c : (await ctx.host.listDir(c).catch(() => [])).map((e) => `${c}/${e.name}`).find((n) => n.endsWith(".csproj"));
    if (!file) continue;
    const text = await ctx.host.readFile(file.replace(/^\.\//, "")).catch(() => "");
    if (/Microsoft\.NET\.Sdk\.Web/.test(text)) {
      return "this is an ASP.NET web project, so `dotnet run` starts a server that never exits. Check it with `dotnet build` instead.";
    }
  }
  return undefined;
}

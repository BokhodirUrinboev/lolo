import type { ChildProcess } from "node:child_process";
import { connect } from "node:net";
import * as path from "node:path";
import { commandEnv, killTree, listenerPid, spawnCommand } from "../host/shell";
import { decideCommand } from "./commandPolicy";
import { truncateOutput } from "./output";
import { resolveWorkspacePath } from "./paths";
import { failureReport } from "./testReport";
import { fail, ok, ToolDef } from "./types";

/**
 * Background processes (servers, watchers) for one agent run. run_command refuses
 * them because they never exit; start_process runs them detached, waits until they
 * are ready, and the run stops them all when it ends.
 */

const MAX_BUFFER = 200_000;
const READY_TIMEOUT_MS = 90_000; // a first `dotnet run` restores and builds
const READY =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]|[\w.-]+):\d+|\b(?:now listening|listening on|listening at|server (?:is )?running|ready in|started server|application started|compiled successfully)\b/i;

interface Proc {
  id: number;
  command: string;
  child: ChildProcess;
  output: string;
  /** Output offset already shown to the model. */
  shown: number;
  exitCode?: number | null;
  /** The port it was started for (start_process `port`), when it opened. */
  port?: number;
  stopped?: boolean;
}

export class ProcessManager {
  private procs = new Map<number, Proc>();
  private nextId = 1;

  constructor(private readonly root: string) {}

  running(): Proc[] {
    return [...this.procs.values()].filter((p) => p.exitCode === undefined);
  }

  get(id: number): Proc | undefined {
    return this.procs.get(id);
  }

  start(command: string, cwd = "."): Proc {
    // Own process group (POSIX) / taskkill /T (Windows), so stop() also ends what the shell started.
    const child = spawnCommand(command, { cwd: path.join(this.root, cwd), env: commandEnv({ FORCE_COLOR: "0", NO_COLOR: "1", BROWSER: "none", CI: "1" }) });
    const p: Proc = { id: this.nextId++, command, child, output: "", shown: 0 };
    const add = (d: Buffer) => {
      p.output += d.toString();
      if (p.output.length > MAX_BUFFER) {
        const cut = p.output.length - MAX_BUFFER;
        p.output = p.output.slice(cut);
        p.shown = Math.max(0, p.shown - cut);
      }
    };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    child.on("error", (e) => {
      p.output += String(e);
      p.exitCode ??= -1;
    });
    child.on("exit", (code) => (p.exitCode = code));
    this.procs.set(p.id, p);
    return p;
  }

  /** Resolves when the process prints a ready line, opens `port`, exits, or the timeout passes. */
  async waitReady(p: Proc, port?: number, signal?: AbortSignal): Promise<"ready" | "exited" | "timeout"> {
    const until = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < until && !signal?.aborted) {
      if (p.exitCode !== undefined) return "exited";
      if (port ? await portOpen(port) : READY.test(p.output)) {
        if (port) p.port = port;
        return "ready";
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return "timeout";
  }

  async stop(p: Proc): Promise<void> {
    if (!p.child.pid || p.stopped) return;
    p.stopped = true;
    if (p.exitCode === undefined) {
      const exited = new Promise<void>((r) => p.child.once("exit", () => r()));
      killTree(p.child.pid, "SIGTERM");
      const t = setTimeout(() => p.child.pid && killTree(p.child.pid, "SIGKILL"), 3000);
      await Promise.race([exited, new Promise((r) => setTimeout(r, 4000))]);
      clearTimeout(t);
    }
    // Windows: a server started through Git Bash can sit outside the process tree taskkill
    // walks; whatever still listens on the port it reported is it.
    const port = p.port ?? Number(/:(\d+)$/.exec(listenUrl(p.output) ?? "")?.[1]);
    const pid = port ? await listenerPid(port) : undefined;
    if (pid && pid !== process.pid) killTree(pid);
  }

  /** Stops every process of this run, including ones whose shell already exited. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.procs.values()].map((p) => this.stop(p)));
  }
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ port, host: "127.0.0.1" });
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.setTimeout(500, () => done(false));
  });
}

/** The address the server listens on; other URLs in the log (docs, advisories) don't count. */
export function listenUrl(output: string): string | undefined {
  const local = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\*|\+):\d+/.exec(output)?.[0];
  const url = local ?? /https?:\/\/[\w.-]+:\d+/.exec(output)?.[0];
  return url?.replace(/0\.0\.0\.0|\[::1?\]|\*|\+/, "localhost");
}

function tail(text: string, lines = 30): string {
  return truncateOutput(text.split("\n").slice(-lines).join("\n"), lines);
}

export const startProcess: ToolDef<{ command: string; cwd?: string; port?: number }> = {
  name: "start_process",
  kind: "exec",
  group: "process",
  description:
    "Start a server or other long-running command in the background and wait until it is ready (prints a URL/'listening', or opens `port`). " +
    "Then test it with run_command (e.g. curl). Starting the same command again restarts it. All background processes are stopped when the task ends.",
  params: {
    type: "object",
    properties: { command: { type: "string", minLength: 1 }, cwd: { type: "string" }, port: { type: "integer", minimum: 1, maximum: 65535 } },
    required: ["command"],
  },
  async check(a, ctx) {
    if (!ctx.processes) return "Background processes are not available here.";
    if (a.cwd === undefined) return undefined;
    const r = resolveWorkspacePath(ctx.host.root, a.cwd);
    if ("error" in r) return r.error;
    if ((await ctx.host.stat(r.path)) !== "dir") return `cwd "${a.cwd}" is not a folder in the workspace.`;
    a.cwd = r.path;
    return undefined;
  },
  async run(a, ctx) {
    const pm = ctx.processes!;
    const decision = decideCommand(a.command, ctx.commandAllowlist);
    if (decision.kind === "block") return fail(`Command blocked (${decision.reason}). Do not retry it.`, `start_process "${a.command}": blocked`);
    if (decision.kind === "confirm") {
      const reason = "starts in the background; stopped when the task ends";
      const approval = ctx.host.approveCommand ? await ctx.host.approveCommand(a.command, reason) : { ok: await ctx.host.confirm(`Start \`${a.command}\` in the background?`) };
      if (!approval.ok) {
        const why = approval.feedback ? ` They said: ${approval.feedback}` : "";
        return fail(`The user declined to start this command.${why}`, `start_process "${a.command}": declined`);
      }
    }
    for (const old of pm.running().filter((p) => p.command === a.command)) await pm.stop(old);
    const p = pm.start(a.command, a.cwd);
    const state = await pm.waitReady(p, a.port, ctx.signal);
    p.shown = p.output.length;
    if (state === "exited") {
      return fail(
        `\`${a.command}\` exited with code ${p.exitCode} before it was ready:\n${failureReport(p.output, ctx.host.root, 40)}`,
        `start_process "${a.command}": exited ${p.exitCode}`,
      );
    }
    const url = listenUrl(p.output);
    const head =
      state === "ready"
        ? `Started \`${a.command}\` in the background (process ${p.id})${url ? `, listening at ${url}` : a.port ? ` on port ${a.port}` : ""}.`
        : `\`${a.command}\` is running in the background (process ${p.id}) but did not report ready within ${READY_TIMEOUT_MS / 1000}s; check process_logs.`;
    return ok(
      `${head}\nRecent output:\n${tail(p.output) || "(none)"}\nTest it with run_command${url ? ` (e.g. curl -s ${url}/)` : ""}; read new output with process_logs.`,
      `start_process "${a.command}": ${state === "ready" ? `ready${url ? ` at ${url}` : ""}` : "still starting"}`,
    );
  },
};

export const processLogs: ToolDef<{ id?: number }> = {
  name: "process_logs",
  kind: "read",
  group: "process",
  description: "New output of a background process since you last looked (default: the most recent one), and whether it is still running.",
  params: { type: "object", properties: { id: { type: "integer", minimum: 1 } } },
  async check(a, ctx) {
    if (!ctx.processes) return "Background processes are not available here.";
    if (a.id !== undefined && !ctx.processes.get(a.id)) return `No background process ${a.id}.`;
    return undefined;
  },
  async run(a, ctx) {
    const pm = ctx.processes!;
    const all = [...pm.running()];
    const p = a.id !== undefined ? pm.get(a.id) : all[all.length - 1];
    if (!p) return ok("No background processes are running.", "process_logs: none");
    const fresh = p.output.slice(p.shown);
    p.shown = p.output.length;
    const status = p.exitCode === undefined ? "running" : `exited with code ${p.exitCode}`;
    return ok(
      `Process ${p.id} (\`${p.command}\`) is ${status}.\n${fresh.trim() ? `New output:\n${tail(fresh, 60)}` : "No new output."}`,
      `process_logs ${p.id}: ${status}`,
    );
  },
};

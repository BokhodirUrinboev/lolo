import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { cleanTerminalOutput } from "../tools/output";
import { commandEnv, commandShell, killTree, spawnCommand } from "./shell";
import { CommandResult, DEFAULT_COMMAND_TIMEOUT_MS, Diagnostic, FileChange, Host } from "./types";

export interface NodeHostOptions {
  /** Apply writes without review (headless default; the run checkpoint still protects). */
  autoApprove?: boolean;
  confirm?: (message: string) => Promise<boolean>;
  askUser?: (question: string) => Promise<string | undefined>;
  /** Called for each write so a CLI can print the change. */
  onWrite?: (path: string, before: string | undefined, after: string) => void;
  commandTimeoutMs?: number;
  interactive?: boolean;
}

/** Plain-filesystem host for the CLI, eval runner and tests. No language server, so diagnostics are empty. */
export class NodeHost implements Host {
  readonly root: string;
  readonly interactive: boolean;

  constructor(root: string, private readonly opts: NodeHostOptions = {}) {
    this.root = path.resolve(root);
    this.interactive = opts.interactive ?? false;
  }

  private abs(p: string) {
    return path.join(this.root, p);
  }

  readFile(p: string) {
    return readFile(this.abs(p), "utf8");
  }

  async stat(p: string) {
    try {
      const s = await stat(this.abs(p));
      return s.isDirectory() ? "dir" : "file";
    } catch {
      return null;
    }
  }

  async listDir(p: string) {
    const entries = await readdir(this.abs(p), { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? ("dir" as const) : ("file" as const) }));
  }

  async proposeWrite(p: string, content: string, info: { isNew: boolean; reason: string }) {
    const before = info.isNew ? undefined : await this.readFile(p).catch(() => undefined);
    if (!this.opts.autoApprove && !(await this.confirm(`Apply ${info.reason}?`))) return { applied: false };
    await mkdir(path.dirname(this.abs(p)), { recursive: true });
    await writeFile(this.abs(p), content);
    this.opts.onWrite?.(p, before, content);
    return { applied: true };
  }

  async diagnostics(): Promise<Diagnostic[]> {
    return [];
  }

  async proposeWrites(changes: FileChange[], reason: string) {
    const list = changes.map((c) => c.path).join(", ");
    if (!this.opts.autoApprove && !(await this.confirm(`Apply ${reason} (${list})?`))) return { applied: false };
    for (const c of changes) {
      const before = await this.readFile(c.path).catch(() => undefined);
      await mkdir(path.dirname(this.abs(c.path)), { recursive: true });
      await writeFile(this.abs(c.path), c.content);
      this.opts.onWrite?.(c.path, before, c.content);
    }
    return { applied: true };
  }

  async moveFile(from: string, to: string) {
    if (!this.opts.autoApprove && !(await this.confirm(`Move ${from} to ${to}?`))) return { applied: false };
    await mkdir(path.dirname(this.abs(to)), { recursive: true });
    await rename(this.abs(from), this.abs(to));
    return { applied: true };
  }

  async deleteFile(p: string) {
    if (!this.opts.autoApprove && !(await this.confirm(`Delete ${p}?`))) return { applied: false };
    await rm(this.abs(p), { recursive: true });
    return { applied: true };
  }

  get shell() {
    return commandShell().label;
  }

  runCommand(command: string, signal?: AbortSignal, opts: { cwd?: string; timeoutMs?: number } = {}): Promise<CommandResult> {
    const timeoutMs = opts.timeoutMs ?? this.opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    return new Promise((resolve) => {
      // A process group (POSIX) or taskkill /T (Windows), so a timeout also stops servers the shell started.
      const p = spawnCommand(command, { cwd: path.join(this.root, opts.cwd ?? "."), env: commandEnv({ MSBUILDTERMINALLOGGER: "off" }) });
      let output = "";
      let timedOut = false;
      const stop = () => (p.pid ? killTree(p.pid) : p.kill());
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
      signal?.addEventListener("abort", stop, { once: true });
      const settle = (r: CommandResult) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        resolve(r);
      };
      p.stdout?.on("data", (d) => (output += d));
      p.stderr?.on("data", (d) => (output += d));
      p.on("error", (e) => settle({ exitCode: -1, output: output + String(e), timedOut }));
      p.on("close", (code) => settle({ exitCode: code ?? -1, output: cleanTerminalOutput(output), timedOut }));
    });
  }

  confirm(message: string) {
    return this.opts.confirm?.(message) ?? Promise.resolve(false);
  }

  askUser(question: string) {
    return this.opts.askUser?.(question) ?? Promise.resolve(undefined);
  }
}

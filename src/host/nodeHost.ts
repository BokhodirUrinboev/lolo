import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { CommandResult, DEFAULT_COMMAND_TIMEOUT_MS, Diagnostic, Host } from "./types";

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

  runCommand(command: string, signal?: AbortSignal, opts: { cwd?: string; timeoutMs?: number } = {}): Promise<CommandResult> {
    const timeoutMs = opts.timeoutMs ?? this.opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    return new Promise((resolve) => {
      // detached: a process group, so a timeout also stops servers the shell started.
      const p = spawn(command, { cwd: path.join(this.root, opts.cwd ?? "."), shell: true, signal, detached: process.platform !== "win32" });
      let output = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (p.pid && process.platform !== "win32") process.kill(-p.pid, "SIGTERM");
          else p.kill();
        } catch {
          /* already gone */
        }
      }, timeoutMs);
      p.stdout.on("data", (d) => (output += d));
      p.stderr.on("data", (d) => (output += d));
      p.on("error", (e) => {
        clearTimeout(timer);
        resolve({ exitCode: -1, output: output + String(e), timedOut });
      });
      p.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? -1, output, timedOut });
      });
    });
  }

  confirm(message: string) {
    return this.opts.confirm?.(message) ?? Promise.resolve(false);
  }

  askUser(question: string) {
    return this.opts.askUser?.(question) ?? Promise.resolve(undefined);
  }
}

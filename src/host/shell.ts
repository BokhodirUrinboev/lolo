import { ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The shell agent commands run in. Models write POSIX commands (`ls`, `cat`, `grep`,
 * `test -f`, `&&`), so on Windows Git Bash is used when it is installed (it comes with
 * Git, which checkpoints need anyway), never WSL's `bash.exe`, which runs in a Linux VM
 * with different paths. Without it, cmd.exe. Elsewhere bash, else /bin/sh.
 * `LOLO_SHELL` names another bash-compatible shell.
 */
export interface CommandShell {
  /** Executable run as `<file> -c <command>`; undefined: spawn's `shell: true` (cmd.exe, /bin/sh). */
  file?: string;
  kind: "bash" | "sh" | "cmd";
  /** For the prompt's Environment line, e.g. "bash (Git Bash)". */
  label: string;
}

let shell: CommandShell | undefined;

export function commandShell(): CommandShell {
  if (shell) return shell;
  const override = process.env.LOLO_SHELL;
  if (override) shell = { file: override, kind: "bash", label: path.basename(override).replace(/\.exe$/i, "") };
  else if (process.platform === "win32") {
    const bash = findGitBash();
    shell = bash ? { file: bash, kind: "bash", label: "bash (Git Bash)" } : { kind: "cmd", label: "cmd.exe" };
  } else if (existsSync("/bin/bash")) shell = { file: "/bin/bash", kind: "bash", label: "bash" };
  else shell = { kind: "sh", label: "/bin/sh" };
  return shell;
}

/** Git for Windows' bash: next to the `git.exe` on PATH, else the usual install folders. */
export function findGitBash(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string | undefined {
  const win = path.win32;
  const candidates: string[] = [];
  for (const dir of (env[pathKey(env)] ?? "").split(";")) {
    if (!dir || !exists(win.join(dir, "git.exe"))) continue;
    // <Git>\cmd\git.exe, <Git>\bin\git.exe or <Git>\mingw64\bin\git.exe
    candidates.push(win.join(dir, "..", "bin", "bash.exe"), win.join(dir, "..", "..", "bin", "bash.exe"));
  }
  for (const base of [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && win.join(env.LOCALAPPDATA, "Programs")]) {
    if (base) candidates.push(win.join(base, "Git", "bin", "bash.exe"));
  }
  if (env.USERPROFILE) candidates.push(win.join(env.USERPROFILE, "scoop", "apps", "git", "current", "bin", "bash.exe"));
  return candidates.find((c) => !/\\(System32|WindowsApps)\\/i.test(c) && exists(c));
}

/** Windows spells it `Path`; a second `PATH` key would be ignored by the child. */
export function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
}

/**
 * Environment for agent commands: `extra` on top of this process's, plus the python3 shims on
 * Windows. Git Bash's path conversion is off: it would turn `grep "/health" server.js` into
 * `grep "C:/Program Files/Git/health"`.
 */
export function commandEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...(process.platform === "win32" ? { MSYS_NO_PATHCONV: "1" } : {}), ...extra };
  const shims = pythonShims();
  if (shims) {
    const key = pathKey(env);
    env[key] = shims + path.delimiter + (env[key] ?? "");
  }
  return env;
}

let shimDir: string | null | undefined;

/**
 * On Windows `python3` is often only the Microsoft Store placeholder ("Python was not
 * found"), while the real interpreter is `python`. Models and project rules write
 * `python3`, so a folder with `python3`/`pip3` shims for cmd and bash goes first on PATH.
 * Returns that folder, or undefined when python3 works (or there is no Python at all).
 */
export function pythonShims(): string | undefined {
  if (process.platform !== "win32") return undefined;
  if (shimDir !== undefined) return shimDir ?? undefined;
  shimDir = null;
  if (isPython3(spawnSync("python3", ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true }))) return undefined;
  const exe = interpreter();
  if (!exe) return undefined;
  try {
    const dir = path.join(os.tmpdir(), "agent-lolo-shims");
    mkdirSync(dir, { recursive: true });
    const posix = exe.replace(/\\/g, "/");
    writeFileSync(path.join(dir, "python3.cmd"), `@"${exe}" %*\r\n`);
    writeFileSync(path.join(dir, "pip3.cmd"), `@"${exe}" -m pip %*\r\n`);
    // Git Bash runs extensionless files that start with #!.
    writeFileSync(path.join(dir, "python3"), `#!/bin/sh\nexec "${posix}" "$@"\n`);
    writeFileSync(path.join(dir, "pip3"), `#!/bin/sh\nexec "${posix}" -m pip "$@"\n`);
    shimDir = dir;
  } catch {
    /* no shims: python3 stays broken, python still works */
  }
  return shimDir ?? undefined;
}

function isPython3(r: { status: number | null; stdout?: string; stderr?: string }): boolean {
  return r.status === 0 && /Python 3/.test(`${r.stdout ?? ""}${r.stderr ?? ""}`);
}

/** Absolute path of a real Python 3 (`python`, else the `py` launcher). */
function interpreter(): string | undefined {
  for (const [cmd, args] of [["python", []], ["py", ["-3"]]] as const) {
    const r = spawnSync(cmd, [...args, "-c", "import sys; print(sys.version_info[0], sys.executable)"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    const m = r.status === 0 ? /^3 (.+)$/m.exec(r.stdout.trim()) : null;
    if (m && existsSync(m[1])) return m[1];
  }
  return undefined;
}

/** Starts `command` in the agent shell. Not detached on Windows (no process groups there; see killTree). */
export function spawnCommand(command: string, opts: { cwd: string; env?: NodeJS.ProcessEnv }): ChildProcess {
  const sh = commandShell();
  const common = { cwd: opts.cwd, env: opts.env ?? commandEnv(), windowsHide: true, detached: process.platform !== "win32" };
  return sh.file ? spawn(sh.file, ["-c", command], common) : spawn(command, { ...common, shell: true });
}

/** Runs `command` in the agent shell and waits (eval checks). */
export function runCommandSync(command: string, opts: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }): { status: number | null; output: string } {
  const sh = commandShell();
  const common = { cwd: opts.cwd, env: opts.env ?? commandEnv(), encoding: "utf8" as const, timeout: opts.timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 };
  const r = sh.file ? spawnSync(sh.file, ["-c", command], common) : spawnSync(command, { ...common, shell: true });
  return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/**
 * Stops a command and everything it started: the process group on POSIX (spawnCommand
 * detaches), `taskkill /T` on Windows (killing only the shell leaves its children
 * running, and they keep the output pipes open).
 */
export function killTree(pid: number, signal: NodeJS.Signals = "SIGTERM") {
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else process.kill(-pid, signal);
  } catch {
    /* already gone */
  }
}

/**
 * Windows: the process listening on a local TCP port (netstat). Git Bash breaks the Windows
 * process tree between its own processes and the native programs they start (`npm run dev` →
 * bash → node → cmd → node server.js), so taskkill /T from the shell can miss a server; the
 * port it reported listening on still leads to it.
 */
export function listenerPid(port: number): Promise<number | undefined> {
  if (process.platform !== "win32") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const p = spawn("netstat", ["-ano", "-p", "TCP"], { windowsHide: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", () => resolve(undefined));
    p.on("close", () => resolve(parseListener(out, port)));
  });
}

export function parseListener(netstat: string, port: number): number | undefined {
  return parseListeners(netstat).get(port);
}

/** port → pid of every listening TCP socket in `netstat -ano` output. */
function parseListeners(netstat: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of netstat.split(/\r?\n/)) {
    const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (m && Number(m[2]) > 0 && !out.has(Number(m[1]))) out.set(Number(m[1]), Number(m[2]));
  }
  return out;
}

/** Windows: the ports something listens on now (a snapshot before a server starts, so we never stop what was already there). */
export function listeningPorts(): Promise<Set<number>> {
  if (process.platform !== "win32") return Promise.resolve(new Set());
  return new Promise((resolve) => {
    const p = spawn("netstat", ["-ano", "-p", "TCP"], { windowsHide: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", () => resolve(new Set()));
    p.on("close", () => resolve(new Set(parseListeners(out).keys())));
  });
}

/** How the prompt tells the model which command syntax to use. */
export function shellAdvice(label: string): string {
  if (/powershell|pwsh/i.test(label)) return `${label}: use PowerShell syntax; chain commands with ";" (no "&&")`;
  if (/cmd/i.test(label)) return `${label}: use Windows commands (dir, type, copy, del), not ls/cat/rm`;
  return process.platform === "win32" ? `${label}: use POSIX commands and forward slashes in paths` : label;
}

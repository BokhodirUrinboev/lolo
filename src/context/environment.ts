import { execFile } from "node:child_process";
import * as os from "node:os";

const TOOLS: [label: string, cmd: string, args: string[]][] = [
  [".NET SDK", "dotnet", ["--version"]],
  ["Node.js", "node", ["--version"]],
  ["Python", "python3", ["--version"]],
  ["Go", "go", ["version"]],
  ["Rust", "cargo", ["--version"]],
  ["Java", "java", ["-version"]],
];

let cached: Promise<string> | undefined;

/**
 * "Environment" block for the system prompt: OS, date and installed toolchains.
 * Small models otherwise assume their training-time versions (e.g. rewrite
 * net10.0 projects to net6.0). Detected once per process.
 */
export function environmentInfo(): Promise<string> {
  cached ??= (async () => {
    const versions = await Promise.all(TOOLS.map(([label, cmd, args]) => version(cmd, args).then((v) => (v ? `${label} ${v}` : ""))));
    const installed = versions.filter(Boolean).join(", ");
    return `OS: ${os.platform()} ${os.arch()}. Installed: ${installed || "unknown"}.`;
  })();
  return cached.then((base) => `Date: ${new Date().toISOString().slice(0, 10)}. ${base}`);
}

function version(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 3000 }, (err, stdout, stderr) => {
      if (err) return resolve("");
      const m = /\d+\.\d+(\.\d+)?/.exec(stdout || stderr);
      resolve(m ? m[0] : "");
    });
  });
}

import { execFile } from "node:child_process";
import * as os from "node:os";
import { commandEnv, shellAdvice } from "../host/shell";

/** [label, candidates]: the first candidate that answers wins (Windows has `python`, often not `python3`). */
const TOOLS: [label: string, candidates: [cmd: string, args: string[]][]][] = [
  [".NET SDK", [["dotnet", ["--version"]]]],
  ["Node.js", [["node", ["--version"]]]],
  ["Python", [["python3", ["--version"]], ["python", ["--version"]]]],
  ["Go", [["go", ["version"]]]],
  ["Rust", [["cargo", ["--version"]]]],
  ["Java", [["java", ["-version"]]]],
];

let cached: Promise<string> | undefined;

/**
 * "Environment" block for the system prompt: OS, shell, date and installed toolchains.
 * Small models otherwise assume their training-time versions (e.g. rewrite net10.0
 * projects to net6.0) and a Linux shell. Toolchains are detected once per process.
 */
export function environmentInfo(shell?: string): Promise<string> {
  cached ??= (async () => {
    const versions = await Promise.all(TOOLS.map(([label, candidates]) => firstVersion(candidates).then((v) => (v ? `${label} ${v}` : ""))));
    const installed = versions.filter(Boolean).join(", ");
    return `OS: ${os.platform()} ${os.arch()}. Installed: ${installed || "unknown"}.`;
  })();
  return cached.then((base) => `Date: ${new Date().toISOString().slice(0, 10)}. ${base}${shell ? ` Shell: ${shellAdvice(shell)}.` : ""}`);
}

async function firstVersion(candidates: [string, string[]][]): Promise<string> {
  for (const [cmd, args] of candidates) {
    const v = await version(cmd, args);
    if (v) return v;
  }
  return "";
}

function version(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 3000, env: commandEnv(), windowsHide: true }, (err, stdout, stderr) => {
      if (err) return resolve("");
      const m = /\d+\.\d+(\.\d+)?/.exec(stdout || stderr);
      resolve(m ? m[0] : "");
    });
  });
}

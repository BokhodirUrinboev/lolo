// Runs dist/test/smoke.js inside VS Code against a temp workspace.
// VSCODE_BIN=<electron binary> uses a local install (the `code` CLI wrapper detaches and
// hides test output; e.g. /usr/share/code/code or /snap/code/current/usr/share/code/code).
// Without it, @vscode/test-electron downloads VS Code (CI).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const ws = mkdtempSync(path.join(tmpdir(), "la-smoke-ws-"));
writeFileSync(path.join(ws, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }));
const userData = mkdtempSync(path.join(tmpdir(), "la-smoke-user-"));
const tests = path.join(root, "dist/test/smoke.js");
const args = [ws, "--new-window", `--user-data-dir=${userData}`, "--disable-extensions", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes"];

if (process.env.VSCODE_BIN) {
  // Set when launched from inside VS Code; it would make Electron run as plain Node.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  execFileSync(process.env.VSCODE_BIN, ["--version"], { stdio: "ignore", env });
  const r = spawnSync(process.env.VSCODE_BIN, [...args, `--extensionDevelopmentPath=${root}`, `--extensionTestsPath=${tests}`], { stdio: "inherit", env });
  process.exit(r.status ?? 1);
} else {
  const { runTests } = await import("@vscode/test-electron");
  try {
    await runTests({ extensionDevelopmentPath: root, extensionTestsPath: tests, launchArgs: args });
  } catch {
    process.exit(1);
  }
}

import type { Host } from "../host/types";
import { listFiles } from "./repoMap";

/**
 * Build/type checks inferred from the project files, used when .agent/rules.md
 * defines no `verify:` commands. Only fast, non-interactive checks: no test
 * runners (they may be slow or watch), no servers.
 */
export async function detectChecks(host: Host): Promise<string[]> {
  const files = (await listFiles(host)).filter((f) => f.split("/").length <= 4);
  const has = (re: RegExp) => files.filter((f) => re.test(f));
  const checks: string[] = [];

  const slns = has(/\.slnx?$/).sort((a, b) => a.split("/").length - b.split("/").length);
  const projs = has(/\.(cs|fs|vb)proj$/);
  if (slns.length) checks.push(`dotnet build ${quote(slns[0])} -v q -nologo`);
  else for (const p of projs.slice(0, 3)) checks.push(`dotnet build ${quote(p)} -v q -nologo`);

  if (files.includes("tsconfig.json") && (await host.stat("node_modules/typescript")) === "dir") checks.push("npx tsc --noEmit -p .");
  if (files.includes("Cargo.toml")) checks.push("cargo check -q");
  if (files.includes("go.mod")) checks.push("go build ./...");
  if (!checks.length && has(/\.py$/).length) checks.push("python3 -m compileall -q .");
  return checks;
}

function quote(p: string) {
  return /^[\w./-]+$/.test(p) ? p : JSON.stringify(p);
}

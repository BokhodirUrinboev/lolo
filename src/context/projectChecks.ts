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

/**
 * .NET projects nested in another project's folder: the outer project compiles the inner
 * one's .cs files (even its obj/ GlobalUsings), so the build fails in the outer project
 * with errors that look like missing packages of the inner one ("Xunit could not be found").
 * Models then keep editing the inner project, which is fine. Returns advice, or undefined.
 */
export function nestedProjectProblem(files: string[]): string | undefined {
  const projects = files.filter((f) => /\.(cs|fs|vb)proj$/.test(f));
  const dirOf = (f: string) => f.split("/").slice(0, -1).join("/");
  for (const inner of projects) {
    const innerDir = dirOf(inner);
    const outer = projects.find((o) => {
      const d = dirOf(o);
      return o !== inner && d !== innerDir && (d === "" || innerDir.startsWith(`${d}/`));
    });
    if (!outer) continue;
    const outerDir = dirOf(outer);
    const rel = outerDir ? innerDir.slice(outerDir.length + 1) : innerDir;
    return (
      `${inner} is inside the folder of ${outer}, so ${outer} also compiles ${innerDir}/**/*.cs and fails with errors about the other project's packages. ` +
      `Fix the layout, not the packages: move ${innerDir} next to ${outerDir || "the project"} (and update its ProjectReference and the solution), ` +
      `or add <ItemGroup><Compile Remove="${rel}/**" /><Content Remove="${rel}/**" /><None Remove="${rel}/**" /></ItemGroup> to ${outer}.`
    );
  }
  return undefined;
}

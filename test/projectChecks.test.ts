import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { detectChecks } from "../src/context/projectChecks";
import { NodeHost } from "../src/host/nodeHost";

function project(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "checks-"));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), c);
  }
  return new NodeHost(root);
}

describe("detectChecks", () => {
  it("builds the solution, or each project, for .NET", async () => {
    expect(await detectChecks(project({ "App.sln": "", "src/App/App.csproj": "" }))).toEqual(["dotnet build App.sln -v q -nologo"]);
    expect(await detectChecks(project({ "TodoApi/TodoApi.csproj": "" }))).toEqual(["dotnet build TodoApi/TodoApi.csproj -v q -nologo"]);
  });
  it("falls back to a Python syntax check and finds nothing for plain folders", async () => {
    expect(await detectChecks(project({ "a.py": "x = 1\n" }))).toEqual(["python3 -m compileall -q ."]);
    expect(await detectChecks(project({ "README.md": "" }))).toEqual([]);
  });
});

describe("NodeHost.runCommand", () => {
  it("runs in cwd and stops commands that exceed the timeout", async () => {
    const host = project({ "sub/x.txt": "hi" });
    expect((await host.runCommand("cat x.txt", undefined, { cwd: "sub" })).output).toBe("hi");
    const t0 = Date.now();
    const r = await host.runCommand("sleep 30", undefined, { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe("run_command server guard", async () => {
  const { runCommand } = await import("../src/tools/runCommand");
  const { EditState } = await import("../src/edit/formats");
  const { resolveProfile } = await import("../src/providers/modelProfiles");
  const ctxFor = (host: NodeHost) => ({ host, profile: resolveProfile("qwen2.5-coder:7b"), edits: new EditState(), commandAllowlist: ["dotnet run", "npm start", "echo"] });

  it("refuses servers and watchers without running them", async () => {
    const host = project({ "Api/Api.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>', "Cli/Cli.csproj": '<Project Sdk="Microsoft.NET.Sdk"></Project>' });
    const web = await runCommand.run({ command: "dotnet run", cwd: "Api" }, ctxFor(host));
    expect(web.ok).toBe(false);
    expect(web.output).toMatch(/dotnet build/);
    expect((await runCommand.run({ command: "dotnet run --project Api/Api.csproj" }, ctxFor(host))).ok).toBe(false);
    expect((await runCommand.run({ command: "npm start" }, ctxFor(host))).summary).toMatch(/refused/);
    expect((await runCommand.run({ command: "echo ok", cwd: "Cli" }, ctxFor(host))).ok).toBe(true);
  });
});

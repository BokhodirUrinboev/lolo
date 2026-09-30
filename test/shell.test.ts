import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { NodeHost } from "../src/host/nodeHost";
import { commandShell, findGitBash, pathKey, runCommandSync, shellAdvice } from "../src/host/shell";

describe("findGitBash", () => {
  const files = (list: string[]) => (p: string) => list.includes(p);

  it("finds bash next to the git.exe on PATH, never WSL's bash", () => {
    const env = { Path: "C:\\Windows\\System32;D:\\Tools\\Git\\cmd", ProgramFiles: "C:\\Program Files" };
    const exists = files(["D:\\Tools\\Git\\cmd\\git.exe", "D:\\Tools\\Git\\bin\\bash.exe", "C:\\Windows\\System32\\bash.exe"]);
    expect(findGitBash(env, exists)).toBe("D:\\Tools\\Git\\bin\\bash.exe");
  });

  it("handles mingw64\\bin on PATH and falls back to the install folders", () => {
    expect(findGitBash({ PATH: "C:\\Git\\mingw64\\bin" }, files(["C:\\Git\\mingw64\\bin\\git.exe", "C:\\Git\\bin\\bash.exe"]))).toBe("C:\\Git\\bin\\bash.exe");
    const env = { PATH: "C:\\Windows\\System32", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" };
    expect(findGitBash(env, files(["C:\\Users\\u\\AppData\\Local\\Programs\\Git\\bin\\bash.exe"]))).toBe("C:\\Users\\u\\AppData\\Local\\Programs\\Git\\bin\\bash.exe");
    expect(findGitBash({ PATH: "C:\\Windows\\System32" }, files(["C:\\Windows\\System32\\bash.exe"]))).toBeUndefined();
  });

  it("reads PATH case-insensitively", () => {
    expect(pathKey({ Path: "x" })).toBe("Path");
    expect(pathKey({})).toBe("PATH");
  });
});

describe("the agent shell", () => {
  it("runs POSIX commands with quotes, && and exit codes (Git Bash on Windows)", () => {
    if (commandShell().kind === "cmd") return; // Windows without Git: cmd.exe
    const dir = mkdtempSync(path.join(tmpdir(), "lolo-sh-"));
    writeFileSync(path.join(dir, "a.txt"), "tax = 0.12\n");
    expect(runCommandSync(`grep -q '0.12' a.txt && echo "found it"`, { cwd: dir }).output.trim()).toBe("found it");
    expect(runCommandSync("test -f missing.txt", { cwd: dir }).status).toBe(1);
    expect(runCommandSync(`! grep -q "absent" a.txt`, { cwd: dir }).status).toBe(0);
    // Git Bash must not turn "/health" into a Windows path.
    writeFileSync(path.join(dir, "routes.txt"), "GET /health\n");
    expect(runCommandSync(`grep -c "/health" routes.txt`, { cwd: dir }).output.trim()).toBe("1");
  });

  it("has a working python3 when Python is installed (shims on Windows)", async () => {
    const host = new NodeHost(mkdtempSync(path.join(tmpdir(), "lolo-py-")));
    const python = await host.runCommand("python --version");
    if (python.exitCode !== 0) return; // no Python on this machine
    const r = await host.runCommand(`python3 -c "print(6 * 7)"`);
    expect(r.output.trim()).toBe("42");
  });

  it("tells the model which syntax the shell takes", () => {
    expect(shellAdvice("PowerShell")).toMatch(/no "&&"/);
    expect(shellAdvice("cmd.exe")).toMatch(/dir, type/);
    expect(shellAdvice("bash")).toMatch(/^bash/);
  });
});

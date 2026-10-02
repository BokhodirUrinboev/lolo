import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { toolNeeds } from "../src/agent/needs";
import { EditState } from "../src/edit/formats";
import { NodeHost } from "../src/host/nodeHost";
import { resolveProfile } from "../src/providers/modelProfiles";
import { ProcessManager } from "../src/tools/processes";
import { ALL_TOOLS, ToolRegistry } from "../src/tools/registry";
import type { ToolContext } from "../src/tools/types";

const SERVER = `const http = require("http");
const s = http.createServer((req, res) => res.end("pong " + req.url));
s.listen(0, "127.0.0.1", () => console.log("listening on http://127.0.0.1:" + s.address().port));
`;

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "lolo-proc-"));
  writeFileSync(path.join(root, "server.js"), SERVER);
  writeFileSync(path.join(root, "crash.js"), "console.error('boom: port in use'); process.exit(3);\n");
  const host = new NodeHost(root, { autoApprove: true });
  const processes = new ProcessManager(root);
  const ctx: ToolContext = { host, profile: resolveProfile("qwen2.5-coder:7b"), edits: new EditState(), commandAllowlist: ["node"], processes };
  return { ctx, processes };
}

const tool = (name: string) => ALL_TOOLS.find((t) => t.name === name)!;

describe("start_process", () => {
  it("is offered only when the todo needs a running server", () => {
    expect(toolNeeds("Start the server and check GET /health with curl").has("process")).toBe(true);
    expect(toolNeeds("Add a GET /health endpoint to src/app.js").has("process")).toBe(false);
  });

  it("starts a server, waits until it listens, and stops it", async () => {
    const { ctx, processes } = setup();
    const r = await tool("start_process").run({ command: "node server.js" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/listening at http:\/\/127\.0\.0\.1:\d+/);
    const url = /http:\/\/127\.0\.0\.1:\d+/.exec(r.output)![0];
    expect(await (await fetch(url + "/ping")).text()).toBe("pong /ping");
    expect(processes.running()).toHaveLength(1);
    const logs = await tool("process_logs").run({}, ctx);
    expect(logs.output).toContain("is running");
    await processes.stopAll();
    await new Promise((res) => setTimeout(res, 200));
    expect(processes.running()).toHaveLength(0);
    await expect(fetch(url)).rejects.toThrow();
  });

  it("reports a process that exits before it is ready", async () => {
    const { ctx } = setup();
    const r = await tool("start_process").run({ command: "node crash.js" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("exited with code 3");
    expect(r.output).toContain("boom: port in use");
  });

  it("treats `node <file>` as a server when the file listens", async () => {
    const { ctx, processes } = setup();
    ctx.commandAllowlist = ["node"];
    const r = await tool("run_command").run({ command: "node server.js" }, ctx);
    expect(r.output).toContain("runs in the background");
    await processes.stopAll();
    const plain = await tool("run_command").run({ command: "node crash.js" }, ctx);
    expect(plain.output).not.toContain("background");
  });

  it("doesn't take a command that only names vite (npm install vite@5) for a server", async () => {
    const { ctx } = setup();
    ctx.commandAllowlist = ["echo"];
    for (const command of ["echo npm create vite@latest app -- --template vue-ts", "echo npm install vue@3 vite@5"]) {
      const r = await tool("run_command").run({ command }, ctx);
      expect(r.ok, command).toBe(true);
      expect(r.output, command).not.toContain("background");
    }
  });

  it("runs `cd dir && ...` from the root when cwd is already that dir", async () => {
    const { ctx } = setup();
    mkdirSync(path.join(ctx.host.root, "web"));
    writeFileSync(path.join(ctx.host.root, "web", "a.txt"), "x");
    ctx.commandAllowlist = ["cd", "ls"];
    const r = await tool("run_command").run({ command: "cd web && ls", cwd: "web" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("a.txt");
  });

  it("lets create_file and rewrite_file replace files a generator made in this run, unread", async () => {
    const { ctx } = setup();
    ctx.commandAllowlist = ["mkdir", "printf"];
    ctx.seen = new Set();
    await tool("run_command").run({ command: "mkdir -p app/src && printf '<template></template>\\n' > app/src/App.vue && printf 'x\\n' > app/src/main.ts" }, ctx);
    const reg = new ToolRegistry();
    const create = await reg.check({ thought: "", tool: "create_file", args: { path: "app/src/App.vue", content: "<template><router-view /></template>\n" } }, ALL_TOOLS, ctx);
    expect(create.ok).toBe(true);
    if (create.ok) expect((await create.tool.run(create.args, ctx)).ok).toBe(true);
    expect(readFileSync(path.join(ctx.host.root, "app/src/App.vue"), "utf8")).toContain("router-view");
    const rewrite = await reg.check({ thought: "", tool: "rewrite_file", args: { path: "app/src/main.ts", content: "console.log(1);\n" } }, ALL_TOOLS, ctx);
    expect(rewrite.ok).toBe(true);
    // A file the user had is still protected.
    const own = await reg.check({ thought: "", tool: "create_file", args: { path: "server.js", content: "x\n" } }, ALL_TOOLS, ctx);
    expect(own.ok).toBe(false);
  });

  it("run_command starts servers in the background instead of refusing them", async () => {
    const { ctx, processes } = setup();
    writeFileSync(path.join(ctx.host.root, "package.json"), JSON.stringify({ scripts: { dev: "node server.js" } }));
    ctx.commandAllowlist = ["npm run dev"];
    const r = await tool("run_command").run({ command: "npm run dev" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("runs in the background");
    expect(r.output).toMatch(/listening at http:\/\/127\.0\.0\.1:\d+/);
    expect(new ToolRegistry().enabled("agent", ctx).map((t) => t.name)).toContain("process_logs");
    const url = /http:\/\/127\.0\.0\.1:\d+/.exec(r.output)![0];
    await processes.stopAll();
    await new Promise((res) => setTimeout(res, 300));
    // npm → shell → node server.js: the server itself must be gone, not just npm.
    await expect(fetch(url)).rejects.toThrow();
  });
});

describe("parseListener", () => {
  it("finds the pid listening on a port in netstat output", async () => {
    const { parseListener } = await import("../src/host/shell");
    const out = [
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1180",
      "  TCP    127.0.0.1:3123         0.0.0.0:0              LISTENING       18536",
      "  TCP    127.0.0.1:3123         127.0.0.1:50000        ESTABLISHED     18536",
      "  TCP    [::]:5173              [::]:0                 LISTENING       9000",
    ].join("\r\n");
    expect(parseListener(out, 3123)).toBe(18536);
    expect(parseListener(out, 5173)).toBe(9000);
    expect(parseListener(out, 80)).toBeUndefined();
  });
});

describe("listenUrl", () => {
  it("prefers the local listening address over other URLs in the log", async () => {
    const { listenUrl } = await import("../src/tools/processes");
    const log = "warning NU1903: Package 'X' has a known vulnerability, https://github.com/advisories/GHSA-2m69\ninfo: Microsoft.Hosting.Lifetime[14]\n      Now listening on: http://[::]:5291\n";
    expect(listenUrl(log)).toBe("http://localhost:5291");
    expect(listenUrl("  ➜  Local:   http://127.0.0.1:5173/")).toBe("http://127.0.0.1:5173");
    expect(listenUrl("see https://docs.example.com/page")).toBeUndefined();
  });
});

describe("nodeBin", () => {
  it("finds nvm's default node when PATH has none", async () => {
    const { nodeBin } = await import("../src/host/shell");
    if (process.platform === "win32") return;
    const home = mkdtempSync(path.join(tmpdir(), "lolo-home-"));
    for (const v of ["v18.20.1", "v22.3.0", "v24.21.0"]) mkdirSync(path.join(home, ".nvm", "versions", "node", v, "bin"), { recursive: true });
    mkdirSync(path.join(home, ".nvm", "alias"));
    writeFileSync(path.join(home, ".nvm", "alias", "default"), "22\n");
    const saved = process.env.NVM_DIR;
    delete process.env.NVM_DIR;
    try {
      expect(nodeBin("/usr/bin/none", home)).toBe(path.join(home, ".nvm", "versions", "node", "v22.3.0", "bin"));
      expect(nodeBin(path.dirname(process.execPath), home)).toBeUndefined(); // node already on PATH
    } finally {
      if (saved !== undefined) process.env.NVM_DIR = saved;
    }
  });
});

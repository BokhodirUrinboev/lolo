import { mkdtempSync, writeFileSync } from "node:fs";
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

  it("run_command starts servers in the background instead of refusing them", async () => {
    const { ctx, processes } = setup();
    writeFileSync(path.join(ctx.host.root, "package.json"), JSON.stringify({ scripts: { dev: "node server.js" } }));
    ctx.commandAllowlist = ["npm run dev"];
    const r = await tool("run_command").run({ command: "npm run dev" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("runs in the background");
    expect(r.output).toMatch(/listening at http:\/\/127\.0\.0\.1:\d+/);
    expect(new ToolRegistry().enabled("agent", ctx).map((t) => t.name)).toContain("process_logs");
    await processes.stopAll();
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

/**
 * Smoke test for VsCodeHost inside a real VS Code (see package.json "test:vscode").
 * Checks the parts that can't be unit-tested: WorkspaceEdit writes, language-server
 * diagnostics, shell-integration command capture, editor context, bundled ripgrep.
 */
import * as assert from "node:assert";
import * as vscode from "vscode";
import type { LocalAgentApi } from "../../src/extension";
import { VsCodeHost } from "../../src/host/vscodeHost";

async function waitFor<T>(get: () => T | undefined, timeoutMs: number): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** The TS server needs a moment to index new files: poll until references across files show up. */
async function pollRefs(host: VsCodeHost) {
  const t0 = Date.now();
  for (;;) {
    const refs = (await host.references({ path: "src/price.ts", line: 1, column: 16 })) ?? [];
    if (refs.some((r) => r.path === "src/use.ts") || Date.now() - t0 > 30_000) return refs;
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function run(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders![0];
  const output = vscode.window.createOutputChannel("smoke");
  // Use the extension's own review manager (it owns the review commands).
  const ext = vscode.extensions.getExtension<LocalAgentApi>("nodirbek.agent-lolo")!;
  const { review, chat, chatReady } = await ext.activate();
  let autoApprove = true;
  const host = new VsCodeHost(folder, { autoApproveEdits: () => autoApprove, review, output });
  const logFile = process.env.SMOKE_LOG;
  const log = (m: string) => {
    console.log(`[smoke] ${m}`);
    if (logFile) require("node:fs").appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`);
  };

  assert.ok((await host.proposeWrite("src/a.ts", 'const n: number = "text";\nexport {};\n', { isNew: true, reason: "create" })).applied);
  assert.strictEqual(await host.stat("src/a.ts"), "file");
  log("create via WorkspaceEdit ok");

  // A fresh instance needs the TS server to start; poll instead of a single settle window.
  let diags = await host.diagnostics(["src/a.ts"]);
  const t0 = Date.now();
  while (!diags.length && Date.now() - t0 < 30_000) diags = await host.diagnostics(["src/a.ts"]);
  log(`diagnostics after ${Date.now() - t0}ms warm-up: ${JSON.stringify(diags)}`);
  assert.ok(diags.some((d) => d.severity === "error" && d.line === 1), "expected a TS type error on line 1");

  assert.ok((await host.proposeWrite("src/a.ts", "const n: number = 1;\nexport {};\n", { isNew: false, reason: "fix" })).applied);
  const after = await host.diagnostics(["src/a.ts"]);
  assert.strictEqual(after.filter((d) => d.severity === "error").length, 0, "errors should clear after fix");
  log("replace + diagnostics refresh ok");

  // LSP references and rename across files (TypeScript language server).
  assert.ok((await host.proposeWrite("src/price.ts", "export function calcTotal(xs: number[]) {\n  return xs.reduce((s, x) => s + x, 0);\n}\n", { isNew: true, reason: "create" })).applied);
  assert.ok((await host.proposeWrite("src/use.ts", 'import { calcTotal } from "./price";\nexport const t = calcTotal([1, 2]);\n', { isNew: true, reason: "create" })).applied);
  const refs = await pollRefs(host);
  log(`references: ${JSON.stringify(refs)}`);
  assert.ok(refs.some((r) => r.path === "src/use.ts" && r.line === 2), "expected a reference in src/use.ts line 2");
  const renamed = await host.renameEdits({ path: "src/price.ts", line: 1, column: 16 }, "sumAll");
  log(`renameEdits: ${JSON.stringify(renamed?.map((c) => c.path))}`);
  assert.ok(renamed?.find((c) => c.path === "src/use.ts")?.content.includes("sumAll([1, 2])"), "rename should update the caller");
  assert.ok((await host.proposeWrites(renamed!, "rename")).applied);
  assert.ok((await host.readFile("src/use.ts")).includes('import { sumAll } from "./price";'));
  log("LSP references + rename ok");

  const r = await host.runCommand("sh -c 'echo smoke-out; exit 3'");
  log(`runCommand: exit ${r.exitCode}, output ${JSON.stringify(r.output.slice(0, 200))}`);
  assert.strictEqual(r.exitCode, 3);
  assert.ok(r.output.includes("smoke-out"));

  await vscode.window.showTextDocument(vscode.Uri.joinPath(folder.uri, "src/a.ts"));
  const ctx = await host.editorContext();
  log(`editorContext: ${JSON.stringify(ctx)}`);
  assert.strictEqual(ctx?.activeFile?.path, "src/a.ts");

  // Inline review: three hunks; accept the first and last, reject the middle.
  const base = ["a", "b", "c", "d", "e", "f", "g"].join("\n") + "\n";
  assert.ok((await host.proposeWrite("src/r.txt", base, { isNew: true, reason: "create r" })).applied);
  autoApprove = false;
  const proposed = ["A", "b", "c", "D", "e", "f", "g", "h"].join("\n") + "\n";
  const reviewing = host.proposeWrite("src/r.txt", proposed, { isNew: false, reason: "edit r" });
  await new Promise((r) => setTimeout(r, 500));
  const uri = vscode.Uri.joinPath(folder.uri, "src/r.txt").toString();
  const lenses = (await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", vscode.Uri.parse(uri))) ?? [];
  log(`review lenses: ${lenses.map((l) => l.command?.title).join(" | ")}`);
  await vscode.commands.executeCommand("localAgent.diff.acceptHunk", uri, 0);
  await vscode.commands.executeCommand("localAgent.diff.rejectHunk", uri, 1);
  await vscode.commands.executeCommand("localAgent.diff.acceptHunk", uri, 2);
  const outcome = await reviewing;
  const final = (await host.readFile("src/r.txt")).replace(/\r\n/g, "\n");
  log(`review outcome ${JSON.stringify(outcome)}; file ${JSON.stringify(final)}`);
  assert.strictEqual(final, ["A", "b", "c", "d", "e", "f", "g", "h"].join("\n") + "\n");
  assert.ok(outcome.applied && outcome.note?.includes("2 of 3"));
  autoApprove = true;

  // Extension activation: every command is registered and the chat view resolves.
  const cmds = await vscode.commands.getCommands(true);
  for (const c of ["localAgent.runTask", "localAgent.inlineEdit", "localAgent.diff.acceptAll", "localAgent.restoreCheckpoint", "localAgent.chat.focus"]) {
    assert.ok(cmds.includes(c), `command ${c} registered`);
  }
  await vscode.commands.executeCommand("localAgent.chat.focus");
  await Promise.race([chatReady, new Promise((_, rej) => setTimeout(() => rej(new Error("chat webview did not load")), 20_000))]);
  log("extension activated; chat webview loaded and connected");

  log(`rgPath: ${host.rgPath()}`);

  // End-to-end through the chat with the real model (local only: needs Ollama).
  if (process.env.SMOKE_E2E) {
    // Private members are reached the way the webview reaches them: through messages.
    const c = chat as unknown as { turns: { items: { kind: string; [k: string]: unknown }[]; running: boolean }[]; onMessage(m: unknown): Promise<void> };
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder.uri, "src/b.ts"), new TextEncoder().encode("export const b = 1;\n"));
    const run = chat.submit("Add the comment line `// hello` as the first line of src/b.ts", "agent");
    const approval = await waitFor(() => c.turns.at(-1)?.items.find((i) => i.kind === "approval" && i.state === "pending"), 180_000).catch((e) => {
      log(`e2e turn so far: ${JSON.stringify(c.turns.at(-1)?.items)}`);
      throw e;
    });
    log(`e2e approval card: ${approval.action} ${approval.target}\n${approval.detail}`);
    assert.ok(String(approval.detail).includes("+// hello"), "diff shows the new line");
    await c.onMessage({ type: "approval", id: approval.id, decision: "yes" });
    await run;
    const text = await host.readFile("src/b.ts");
    const result = c.turns.at(-1)!.items.find((i) => i.kind === "result");
    log(`e2e result: ${JSON.stringify(result)}; file: ${JSON.stringify(text)}`);
    assert.ok(text.startsWith("// hello"), "edit applied after approval");

    // Conversation memory: a follow-up question about the previous turn.
    await chat.submit("what did you just change?", "agent");
    const answer = c.turns.at(-1)!.items.find((i) => i.kind === "result");
    log(`e2e follow-up: ${JSON.stringify(answer?.summary)}`);
  }
  assert.ok(host.rgPath(), "bundled ripgrep not found");
  assert.ok(!r.output.includes("\x1b]"), "OSC markers should be stripped");
  host.dispose();
}

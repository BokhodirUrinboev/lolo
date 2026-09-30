import { existsSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { EditorContext } from "../context/collectors";
import type { SymbolLocation } from "../context/mentions";
import type { DiffReviewManager } from "../edit/diffView";
import { cleanTerminalOutput } from "../tools/output";
import { commandEnv, commandShell, killTree, pathKey, pythonShims, spawnCommand } from "./shell";
import { Approval, ApprovalRequest, CommandResult, DEFAULT_COMMAND_TIMEOUT_MS, Diagnostic, FileChange, Host, SourcePos, WriteOutcome } from "./types";

export interface VsCodeHostOptions {
  autoApproveEdits: () => boolean;
  review: DiffReviewManager;
  output: vscode.OutputChannel;
}

const DIAGNOSTICS_SETTLE_MS = 3000;

export class VsCodeHost implements Host {
  readonly interactive = true;
  private terminal: vscode.Terminal | undefined;
  private lastTerminalOutput = "";

  constructor(readonly folder: vscode.WorkspaceFolder, private readonly opts: VsCodeHostOptions) {}

  get root() {
    return this.folder.uri.fsPath;
  }

  private uri(p: string) {
    return vscode.Uri.joinPath(this.folder.uri, ...p.split("/"));
  }

  private rel(uri: vscode.Uri) {
    return path.relative(this.root, uri.fsPath).replace(/\\/g, "/");
  }

  /** Prefers the open (possibly unsaved) document over disk. */
  async readFile(p: string) {
    const uri = this.uri(p);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) return open.getText();
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  }

  async stat(p: string) {
    try {
      const s = await vscode.workspace.fs.stat(this.uri(p));
      return s.type & vscode.FileType.Directory ? "dir" : "file";
    } catch {
      return null;
    }
  }

  async listDir(p: string) {
    const entries = await vscode.workspace.fs.readDirectory(this.uri(p));
    return entries.map(([name, type]) => ({ name, type: type & vscode.FileType.Directory ? ("dir" as const) : ("file" as const) }));
  }

  /**
   * Auto-approve: writes via WorkspaceEdit (native undo). Otherwise shows the change
   * inline with per-hunk Accept/Reject and waits for the user's decisions.
   */
  async proposeWrite(p: string, content: string, info: { isNew: boolean; reason: string }): Promise<WriteOutcome> {
    const target = this.uri(p);
    if (!this.opts.autoApproveEdits() && this.approvalHandler) {
      // Chat run: a permission card with the diff (Yes / Yes, don't ask again / No + feedback).
      const before = info.isNew ? "" : await this.readFile(p);
      const a = await this.approvalHandler({ kind: "edit", path: p, isNew: info.isNew, reason: info.reason, before, after: content });
      if (!a.ok) return { applied: false, note: a.feedback };
    } else if (!this.opts.autoApproveEdits()) {
      // No chat attached: review inline in the editor.
      const before = info.isNew ? undefined : await this.readFile(p);
      const r = await this.opts.review.review(target, before, content);
      if (r.total === 0) return { applied: true };
      if (r.accepted === 0) return { applied: false };
      return r.accepted === r.total ? { applied: true } : { applied: true, note: `the user accepted only ${r.accepted} of ${r.total} changed blocks` };
    }
    const edit = new vscode.WorkspaceEdit();
    if (info.isNew) {
      edit.createFile(target, { ignoreIfExists: false, contents: new TextEncoder().encode(content) });
    } else {
      const doc = await vscode.workspace.openTextDocument(target);
      edit.replace(target, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), content);
    }
    if (!(await vscode.workspace.applyEdit(edit))) return { applied: false };
    const doc = await vscode.workspace.openTextDocument(target);
    await doc.save();
    return { applied: true };
  }

  /** One approval card for all files (a rename), then one WorkspaceEdit so a single undo reverts it. */
  async proposeWrites(changes: FileChange[], reason: string): Promise<WriteOutcome> {
    const files = await Promise.all(changes.map(async (c) => ({ path: c.path, before: await this.readFile(c.path).catch(() => ""), after: c.content })));
    if (!this.opts.autoApproveEdits()) {
      const a = this.approvalHandler
        ? await this.approvalHandler({ kind: "edits", reason, files })
        : { ok: await this.confirm(`Apply ${reason} to ${changes.map((c) => c.path).join(", ")}?`) };
      if (!a.ok) return { applied: false, note: a.feedback };
    }
    const edit = new vscode.WorkspaceEdit();
    for (const c of changes) {
      const doc = await vscode.workspace.openTextDocument(this.uri(c.path));
      edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), c.content);
    }
    if (!(await vscode.workspace.applyEdit(edit))) return { applied: false };
    for (const c of changes) await (await vscode.workspace.openTextDocument(this.uri(c.path))).save();
    return { applied: true };
  }

  async references(pos: SourcePos): Promise<SourcePos[] | undefined> {
    try {
      const doc = await vscode.workspace.openTextDocument(this.uri(pos.path));
      const locs = await vscode.commands.executeCommand<vscode.Location[]>(
        "vscode.executeReferenceProvider",
        doc.uri,
        new vscode.Position(pos.line - 1, pos.column),
      );
      if (!locs?.length) return undefined;
      return locs
        .filter((l) => l.uri.scheme === "file" && l.uri.fsPath.startsWith(this.root))
        .map((l) => ({ path: this.rel(l.uri), line: l.range.start.line + 1, column: l.range.start.character }));
    } catch {
      return undefined;
    }
  }

  /** Runs the language server's rename and returns the resulting file contents without applying them. */
  async renameEdits(pos: SourcePos, newName: string): Promise<FileChange[] | undefined> {
    try {
      const doc = await vscode.workspace.openTextDocument(this.uri(pos.path));
      const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit | undefined>(
        "vscode.executeDocumentRenameProvider",
        doc.uri,
        new vscode.Position(pos.line - 1, pos.column),
        newName,
      );
      if (!edit || edit.size === 0) return undefined;
      const out: FileChange[] = [];
      for (const [uri, edits] of edit.entries()) {
        if (uri.scheme !== "file" || !uri.fsPath.startsWith(this.root)) return undefined; // would touch files outside the workspace
        const d = await vscode.workspace.openTextDocument(uri);
        let text = d.getText();
        const sorted = [...edits].sort((a, b) => d.offsetAt(b.range.start) - d.offsetAt(a.range.start));
        for (const e of sorted) text = text.slice(0, d.offsetAt(e.range.start)) + e.newText + text.slice(d.offsetAt(e.range.end));
        out.push({ path: this.rel(uri), content: text });
      }
      return out;
    } catch {
      return undefined; // no rename provider, or the position is not renameable
    }
  }

  /**
   * Waits briefly for language servers to publish fresh diagnostics for `paths`.
   * Files are shown in a background preview editor: some servers (TypeScript) only
   * check documents that are visible.
   */
  async diagnostics(paths?: string[]): Promise<Diagnostic[]> {
    if (paths?.length) {
      const uris = paths.map((p) => this.uri(p));
      const settled = waitForDiagnostics(uris, DIAGNOSTICS_SETTLE_MS);
      for (const u of uris) {
        await vscode.workspace.openTextDocument(u).then(
          (doc) => vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true }),
          () => undefined,
        );
      }
      await settled;
    }
    const wanted = paths ? new Set(paths) : undefined;
    const out: Diagnostic[] = [];
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      if (uri.scheme !== "file" || !uri.fsPath.startsWith(this.root)) continue;
      const rel = this.rel(uri);
      if (wanted && !wanted.has(rel)) continue;
      for (const d of diags) {
        if (d.severity > vscode.DiagnosticSeverity.Warning) continue;
        out.push({ path: rel, line: d.range.start.line + 1, severity: d.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning", message: d.message });
      }
    }
    return out;
  }

  /**
   * Runs in a visible terminal via shell integration (output + exit code), falling
   * back to a hidden child process when shell integration is unavailable.
   */
  /**
   * On Windows the agent's terminal is Git Bash when installed: models write POSIX
   * commands, and PowerShell 5.1 has no `&&`. Otherwise the user's default shell.
   */
  private readonly gitBash = process.platform === "win32" ? commandShell().file : undefined;

  get shell() {
    if (this.gitBash) return commandShell().label;
    if (process.platform === "win32") return "PowerShell";
    return path.basename(vscode.env.shell || "bash");
  }

  async runCommand(command: string, signal?: AbortSignal, opts: { cwd?: string; timeoutMs?: number } = {}): Promise<CommandResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const dir = path.join(this.root, opts.cwd ?? ".");
    const term = await this.agentTerminal();
    const shell = term.shellIntegration;
    if (!shell) return this.runHidden(command, signal, dir, timeoutMs);
    term.show(true);
    // The terminal keeps its directory between commands, so always cd explicitly.
    const cd =
      process.platform === "win32" && !this.gitBash
        ? `Set-Location -LiteralPath '${dir.replace(/'/g, "''")}'; ` // PowerShell 5.1: no `&&`
        : `cd ${JSON.stringify(process.platform === "win32" ? dir.replace(/\\/g, "/") : dir)} && `;
    const execution = shell.executeCommand(`${cd}${command}`);
    let timedOut = false;
    let output = "";
    const exit = new Promise<number>((resolve) => {
      const sub = vscode.window.onDidEndTerminalShellExecution((e) => {
        if (e.execution === execution) {
          sub.dispose();
          resolve(e.exitCode ?? -1);
        }
      });
      // A command that exits the shell never reports an end event.
      const closed = vscode.window.onDidCloseTerminal((t) => {
        if (t === term) {
          closed.dispose();
          resolve(t.exitStatus?.code ?? -1);
        }
      });
      signal?.addEventListener("abort", () => {
        term.sendText("\x03", false);
        resolve(-1);
      });
      setTimeout(() => {
        timedOut = true;
        term.sendText("\x03", false); // Ctrl+C: stop servers/watchers
        resolve(-1);
      }, timeoutMs);
    });
    const read = (async () => {
      for await (const chunk of execution.read()) output += chunk;
    })();
    const exitCode = await exit;
    await Promise.race([read, new Promise((r) => setTimeout(r, 500))]);
    output = cleanTerminalOutput(output); // shell-integration markers, colors, progress redraws
    this.lastTerminalOutput = output;
    return { exitCode, output, timedOut };
  }

  private async agentTerminal(): Promise<vscode.Terminal> {
    if (this.terminal && this.terminal.exitStatus === undefined) return this.terminal;
    // MSBuild's terminal logger redraws progress lines, which the captured output turns into noise.
    const env: Record<string, string> = { MSBUILDTERMINALLOGGER: "off" };
    const shims = pythonShims();
    if (shims) env.PATH = shims + path.delimiter + (process.env[pathKey(process.env)] ?? "");
    this.terminal = vscode.window.createTerminal({
      name: "Agent Lolo",
      cwd: this.folder.uri,
      isTransient: true,
      env,
      // CHERE_INVOKING keeps a Git Bash login shell in cwd; MSYS_NO_PATHCONV keeps "/health" from becoming a Windows path.
      ...(this.gitBash ? { shellPath: this.gitBash, shellArgs: ["--login", "-i"], env: { ...env, CHERE_INVOKING: "1", MSYS_NO_PATHCONV: "1" } } : {}),
    });
    // A terminal that was never shown may not start its shell.
    this.terminal.show(true);
    // Shell integration activates asynchronously after the shell starts.
    if (!this.terminal.shellIntegration) {
      await new Promise<void>((resolve) => {
        const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
          if (e.terminal === this.terminal) {
            sub.dispose();
            resolve();
          }
        });
        setTimeout(() => {
          sub.dispose();
          resolve();
        }, 4000);
      });
    }
    return this.terminal;
  }

  private runHidden(command: string, signal: AbortSignal | undefined, cwd: string, timeoutMs: number): Promise<CommandResult> {
    this.opts.output.appendLine(`$ ${command}  (shell integration unavailable; running hidden)`);
    return new Promise((resolve) => {
      const p = spawnCommand(command, { cwd, env: commandEnv({ MSBUILDTERMINALLOGGER: "off" }) });
      let output = "";
      let timedOut = false;
      const stop = () => (p.pid ? killTree(p.pid) : p.kill());
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
      signal?.addEventListener("abort", stop, { once: true });
      p.stdout?.on("data", (d) => (output += d));
      p.stderr?.on("data", (d) => (output += d));
      p.on("error", (e) => {
        clearTimeout(timer);
        resolve({ exitCode: -1, output: output + String(e), timedOut });
      });
      p.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        output = cleanTerminalOutput(output);
        this.lastTerminalOutput = output;
        resolve({ exitCode: code ?? -1, output, timedOut });
      });
    });
  }

  async confirm(message: string) {
    return (await vscode.window.showWarningMessage(message, { modal: true }, "Yes")) === "Yes";
  }

  /** Set by the chat panel during a run: permissions become cards in the conversation. */
  approvalHandler?: (req: ApprovalRequest) => Promise<Approval>;

  async approveCommand(command: string, reason: string): Promise<Approval> {
    if (this.approvalHandler) return this.approvalHandler({ kind: "command", command, reason });
    return { ok: await this.confirm(`Run \`${command}\`? (${reason})`) };
  }

  /** File moves and deletes always ask, even with auto-approved edits (reuses the command approval card). */
  async moveFile(from: string, to: string): Promise<WriteOutcome> {
    const a = await this.approveCommand(`move ${from} → ${to}`, "moves the file");
    if (!a.ok) return { applied: false, note: a.feedback };
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.uri(to), ".."));
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(this.uri(from), this.uri(to), { overwrite: false });
    return { applied: await vscode.workspace.applyEdit(edit) };
  }

  async deleteFile(p: string): Promise<WriteOutcome> {
    const a = await this.approveCommand(`delete ${p}`, "deletes the file (a checkpoint was taken before the run)");
    if (!a.ok) return { applied: false, note: a.feedback };
    const edit = new vscode.WorkspaceEdit();
    edit.deleteFile(this.uri(p), { recursive: true });
    return { applied: await vscode.workspace.applyEdit(edit) };
  }

  /** Set by the chat panel during a run so questions appear in the conversation. */
  askHandler?: (question: string) => Promise<string | undefined>;

  askUser(question: string) {
    if (this.askHandler) return this.askHandler(question);
    return Promise.resolve(vscode.window.showInputBox({ title: "Agent Lolo asks", prompt: question, ignoreFocusOut: true }));
  }

  async editorContext(): Promise<EditorContext | undefined> {
    const editor = vscode.window.activeTextEditor;
    const inWorkspace = (u: vscode.Uri) => u.scheme === "file" && u.fsPath.startsWith(this.root);
    const ctx: EditorContext = {};
    if (editor && inWorkspace(editor.document.uri)) {
      const sel = editor.selection;
      ctx.activeFile = {
        path: this.rel(editor.document.uri),
        cursorLine: sel.active.line + 1,
        selection: sel.isEmpty ? undefined : { startLine: sel.start.line + 1, endLine: sel.end.line + 1, text: editor.document.getText(sel) },
      };
    }
    ctx.openTabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .map((t) => (t.input instanceof vscode.TabInputText ? t.input.uri : undefined))
      .filter((u): u is vscode.Uri => !!u && inWorkspace(u))
      .map((u) => this.rel(u));
    ctx.terminalOutput = this.lastTerminalOutput || undefined;
    return ctx;
  }

  async workspaceSymbols(query: string): Promise<SymbolLocation[]> {
    const found = (await vscode.commands.executeCommand<vscode.SymbolInformation[]>("vscode.executeWorkspaceSymbolProvider", query)) ?? [];
    return found
      .filter((s) => s.location.uri.scheme === "file" && s.location.uri.fsPath.startsWith(this.root))
      .map((s) => ({ name: s.name, path: this.rel(s.location.uri), line: s.location.range.start.line + 1 }));
  }

  rgPath() {
    // VS Code ships ripgrep; the location moved between versions.
    const base = vscode.env.appRoot;
    const bin = process.platform === "win32" ? "rg.exe" : "rg";
    const platformDir = `${process.platform}-${process.arch}`;
    for (const dir of [
      `node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/${platformDir}`,
      "node_modules/@vscode/ripgrep/bin",
      "node_modules.asar.unpacked/@vscode/ripgrep/bin",
    ]) {
      const p = path.join(base, dir, bin);
      if (existsSync(p)) return p;
    }
    return undefined;
  }

  dispose() {
    this.terminal?.dispose();
  }
}

function waitForDiagnostics(uris: vscode.Uri[], timeoutMs: number): Promise<void> {
  const keys = new Set(uris.map((u) => u.toString()));
  return new Promise((resolve) => {
    const done = () => {
      sub.dispose();
      clearTimeout(timer);
      resolve();
    };
    // Language servers often publish twice (syntax, then semantic); take the first
    // update, then allow a short grace period for the second.
    const sub = vscode.languages.onDidChangeDiagnostics((e) => {
      if (e.uris.some((u) => keys.has(u.toString()))) setTimeout(done, 300);
    });
    const timer = setTimeout(done, timeoutMs);
  });
}

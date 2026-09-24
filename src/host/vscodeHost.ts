import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { EditorContext } from "../context/collectors";
import type { SymbolLocation } from "../context/mentions";
import type { DiffReviewManager } from "../edit/diffView";
import { Approval, ApprovalRequest, CommandResult, DEFAULT_COMMAND_TIMEOUT_MS, Diagnostic, Host, WriteOutcome } from "./types";

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
  async runCommand(command: string, signal?: AbortSignal, opts: { cwd?: string; timeoutMs?: number } = {}): Promise<CommandResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const dir = path.join(this.root, opts.cwd ?? ".");
    const term = await this.agentTerminal();
    const shell = term.shellIntegration;
    if (!shell) return this.runHidden(command, signal, dir, timeoutMs);
    term.show(true);
    // The terminal keeps its directory between commands, so always cd explicitly.
    // Windows' default shell is PowerShell 5.1, which has no `&&`.
    const cd = process.platform === "win32" ? `Set-Location -LiteralPath '${dir.replace(/'/g, "''")}'; ` : `cd ${JSON.stringify(dir)} && `;
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
    output = output.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ""); // shell-integration OSC markers
    this.lastTerminalOutput = output;
    return { exitCode, output, timedOut };
  }

  private async agentTerminal(): Promise<vscode.Terminal> {
    if (this.terminal && this.terminal.exitStatus === undefined) return this.terminal;
    this.terminal = vscode.window.createTerminal({ name: "Agent Lolo", cwd: this.folder.uri, isTransient: true });
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
      const p = spawn(command, { cwd, shell: true, signal, timeout: timeoutMs });
      let output = "";
      p.stdout.on("data", (d) => (output += d));
      p.stderr.on("data", (d) => (output += d));
      p.on("error", (e) => resolve({ exitCode: -1, output: output + String(e) }));
      p.on("close", (code) => {
        this.lastTerminalOutput = output;
        resolve({ exitCode: code ?? -1, output });
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

import * as vscode from "vscode";
import { diffLines, mergeForReview, MergedHunk } from "./lineDiff";
import { detectEol, toLf } from "./text";

export interface ReviewResult {
  accepted: number;
  rejected: number;
  total: number;
}

const CONTEXT_KEY = "localAgent.diffPending";

/**
 * Inline diff review. The proposed change is written into the real document with
 * each hunk's old lines (red) followed by its new lines (green); per-hunk CodeLens
 * Accept/Reject deletes one side. All changes go through WorkspaceEdit, so native
 * undo works, and the document is saved once every hunk is decided.
 */
export class DiffReviewManager implements vscode.CodeLensProvider, vscode.Disposable {
  private sessions = new Map<string, ReviewSession>();
  private lensEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensEmitter.event;
  private disposables: vscode.Disposable[] = [];
  readonly removedDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("diffEditor.removedLineBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.deletedForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  readonly addedDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.addedForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });

  constructor() {
    this.disposables.push(
      vscode.languages.registerCodeLensProvider({ scheme: "file" }, this),
      vscode.commands.registerCommand("localAgent.diff.acceptHunk", (uri: string, id: number) => this.sessions.get(uri)?.resolveHunk(id, true)),
      vscode.commands.registerCommand("localAgent.diff.rejectHunk", (uri: string, id: number) => this.sessions.get(uri)?.resolveHunk(id, false)),
      vscode.commands.registerCommand("localAgent.diff.acceptAll", (uri?: string) => this.forActive(uri)?.resolveAll(true)),
      vscode.commands.registerCommand("localAgent.diff.rejectAll", (uri?: string) => this.forActive(uri)?.resolveAll(false)),
      vscode.workspace.onDidChangeTextDocument((e) => this.sessions.get(e.document.uri.toString())?.onChange(e)),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContext()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.sessions.forEach((s) => s.decorate())),
    );
  }

  /**
   * Shows `newText` as a pending change to `uri` and resolves when the user has
   * decided every hunk. For new files pass `oldText = undefined`.
   */
  async review(uri: vscode.Uri, oldText: string | undefined, newText: string, opts: { save?: boolean } = {}): Promise<ReviewResult> {
    const key = uri.toString();
    await this.sessions.get(key)?.resolveAll(false);
    if (oldText === undefined) {
      const create = new vscode.WorkspaceEdit();
      create.createFile(uri, { ignoreIfExists: true });
      await vscode.workspace.applyEdit(create);
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const base = oldText ?? "";
    const oldLines = toLf(base).split("\n");
    const newLines = toLf(newText).split("\n");
    const hunks = diffLines(base === "" ? [] : oldLines, newLines);
    if (!hunks.length) return { accepted: 0, rejected: 0, total: 0 };
    const merged = mergeForReview(base === "" ? [] : oldLines, hunks);
    const session = new ReviewSession(this, doc, merged.hunks, detectEol(oldText ?? newText), oldText === undefined, opts.save ?? true);
    this.sessions.set(key, session);
    const done = session.start(merged.lines);
    this.updateContext();
    this.lensEmitter.fire();
    const result = await done;
    this.sessions.delete(key);
    this.updateContext();
    this.lensEmitter.fire();
    return result;
  }

  /** Rejects every pending hunk (run cancelled). */
  async rejectAll() {
    for (const s of [...this.sessions.values()]) await s.resolveAll(false);
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const s = this.sessions.get(doc.uri.toString());
    if (!s) return [];
    const uri = doc.uri.toString();
    const lenses: vscode.CodeLens[] = [];
    const pending = s.pending();
    if (pending.length > 1) {
      const top = new vscode.Range(pending[0].start, 0, pending[0].start, 0);
      lenses.push(
        new vscode.CodeLens(top, { title: `$(check-all) Accept all (${pending.length})`, command: "localAgent.diff.acceptAll", arguments: [uri] }),
        new vscode.CodeLens(top, { title: "$(close-all) Reject all", command: "localAgent.diff.rejectAll", arguments: [uri] }),
      );
    }
    for (const h of pending) {
      const r = new vscode.Range(h.start, 0, h.start, 0);
      lenses.push(
        new vscode.CodeLens(r, { title: "$(check) Accept", command: "localAgent.diff.acceptHunk", arguments: [uri, h.id] }),
        new vscode.CodeLens(r, { title: "$(close) Reject", command: "localAgent.diff.rejectHunk", arguments: [uri, h.id] }),
      );
    }
    return lenses;
  }

  refreshLenses() {
    this.lensEmitter.fire();
  }

  private forActive(uri?: string) {
    const key = uri ?? vscode.window.activeTextEditor?.document.uri.toString();
    return key ? this.sessions.get(key) : undefined;
  }

  private updateContext() {
    const active = vscode.window.activeTextEditor?.document.uri.toString();
    void vscode.commands.executeCommand("setContext", CONTEXT_KEY, !!active && this.sessions.has(active));
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
    this.removedDecoration.dispose();
    this.addedDecoration.dispose();
  }
}

class ReviewSession {
  private resolved = new Set<number>();
  private accepted = 0;
  private finish!: (r: ReviewResult) => void;
  /** Serializes our own edits so change events are processed in order. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly mgr: DiffReviewManager,
    private readonly doc: vscode.TextDocument,
    private readonly hunks: MergedHunk[],
    private readonly eol: "\r\n" | "\n",
    private readonly isNew: boolean,
    private readonly save: boolean,
  ) {}

  start(lines: string[]): Promise<ReviewResult> {
    const done = new Promise<ReviewResult>((r) => (this.finish = r));
    this.queue = this.queue.then(async () => {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(this.doc.uri, new vscode.Range(0, 0, this.doc.lineCount, 0), lines.join(this.eol));
      // The replace fires onChange with a whole-document range; hunks are already in merged coordinates.
      this.ignoreNext = true;
      await vscode.workspace.applyEdit(edit);
      await vscode.window.showTextDocument(this.doc, { preview: false, preserveFocus: true });
      this.decorate();
    });
    return done;
  }

  private ignoreNext = false;

  pending() {
    return this.hunks.filter((h) => !this.resolved.has(h.id));
  }

  resolveHunk(id: number, accept: boolean) {
    this.queue = this.queue.then(() => this.apply(id, accept));
    return this.queue;
  }

  resolveAll(accept: boolean) {
    // Bottom-up so earlier hunks' positions stay valid while we edit.
    for (const h of [...this.pending()].reverse()) this.queue = this.queue.then(() => this.apply(h.id, accept));
    return this.queue;
  }

  private async apply(id: number, accept: boolean) {
    const h = this.hunks.find((x) => x.id === id);
    if (!h || this.resolved.has(id)) return;
    this.resolved.add(id);
    if (accept) this.accepted++;
    const from = accept ? h.start : h.start + h.removed;
    const count = accept ? h.removed : h.added;
    if (count > 0) {
      const edit = new vscode.WorkspaceEdit();
      edit.delete(this.doc.uri, this.lineBlock(from, count));
      await vscode.workspace.applyEdit(edit);
    }
    this.decorate();
    this.mgr.refreshLenses();
    if (!this.pending().length) await this.complete();
  }

  /** Range covering `count` whole lines from `from`, including the line break that belongs to them. */
  private lineBlock(from: number, count: number): vscode.Range {
    const last = this.doc.lineCount - 1;
    const to = from + count;
    if (to <= last) return new vscode.Range(from, 0, to, 0);
    // Block runs to the end: take the preceding line break instead of a trailing one.
    if (from === 0) return new vscode.Range(0, 0, last, this.doc.lineAt(last).text.length);
    return new vscode.Range(from - 1, this.doc.lineAt(from - 1).text.length, last, this.doc.lineAt(last).text.length);
  }

  /** Keeps hunk positions in sync with every edit, ours or the user's. */
  onChange(e: vscode.TextDocumentChangeEvent) {
    if (this.ignoreNext) {
      this.ignoreNext = false;
      return;
    }
    for (const c of e.contentChanges) {
      const delta = c.text.split(/\r?\n/).length - 1 - (c.range.end.line - c.range.start.line);
      if (!delta) continue;
      for (const h of this.hunks) {
        if (this.resolved.has(h.id) && !this.hunkAfter(h, c.range)) continue;
        if (this.hunkAfter(h, c.range)) h.start += delta;
        else if (c.range.start.line >= h.start && c.range.start.line < h.start + h.removed + h.added) {
          // User typed inside a pending hunk: grow/shrink the side they edited.
          if (c.range.start.line >= h.start + h.removed) h.added = Math.max(0, h.added + delta);
          else h.removed = Math.max(0, h.removed + delta);
        }
      }
    }
    this.decorate();
  }

  private hunkAfter(h: MergedHunk, r: vscode.Range) {
    return r.end.line < h.start || (r.end.line === h.start && r.end.character === 0 && r.start.line < h.start);
  }

  decorate() {
    const removed: vscode.Range[] = [];
    const added: vscode.Range[] = [];
    for (const h of this.pending()) {
      if (h.removed) removed.push(new vscode.Range(h.start, 0, h.start + h.removed - 1, 0));
      if (h.added) added.push(new vscode.Range(h.start + h.removed, 0, h.start + h.removed + h.added - 1, 0));
    }
    for (const ed of vscode.window.visibleTextEditors.filter((e) => e.document === this.doc)) {
      ed.setDecorations(this.mgr.removedDecoration, removed);
      ed.setDecorations(this.mgr.addedDecoration, added);
    }
  }

  private async complete() {
    const total = this.hunks.length;
    if (this.isNew && this.accepted === 0) {
      const del = new vscode.WorkspaceEdit();
      del.deleteFile(this.doc.uri, { ignoreIfNotExists: true });
      await vscode.workspace.applyEdit(del);
    } else if (this.save) {
      await this.doc.save();
    }
    this.finish({ accepted: this.accepted, rejected: total - this.accepted, total });
  }
}

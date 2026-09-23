import * as vscode from "vscode";
import type { AgentEvent, RunOptions, RunResult } from "../agent/loop";
import { listFiles } from "../context/repoMap";
import { unifiedDiff } from "../edit/lineDiff";
import type { Approval, ApprovalRequest, Host } from "../host/types";
import type { FromWebview, Item, Mode, ToWebview, Turn, ViewState } from "./protocol";
import { applyEvent, conversationText, pendingPlanFor } from "./transcript";

const HISTORY_KEY = "localAgent.chatHistory";
const MAX_TURNS = 50;
/** "dotnet new webapi -n X" → "dotnet new": what "don't ask again" allows. */
function commandPrefix(cmd: string): string {
  return cmd.trim().split(/\s+/).slice(0, 2).join(" ");
}

export interface ChatBackend {
  /** Runs the agent; events go to `onEvent`. */
  run(
    text: string,
    mode: Mode,
    hooks: {
      onEvent: (e: AgentEvent) => void;
      reviewPlan: (todos: string[]) => Promise<string[] | undefined>;
      askUser: (question: string) => Promise<string | undefined>;
      approve: (req: ApprovalRequest) => Promise<Approval>;
      signal: AbortSignal;
    },
    opts: RunOptions,
  ): Promise<RunResult>;
  /** Opens VS Code's diff editor for a proposed change. */
  openDiff(path: string, before: string, after: string): Promise<void>;
  listModels(): Promise<string[]>;
  currentModel(): string;
  setModel(model: string): Promise<void>;
  restore(checkpoint: string): Promise<void>;
  applyCode(code: string): Promise<void>;
  host(): Host | undefined;
}

/** Sidebar chat. Owns the transcript (persisted in workspaceState) and turns agent events into UI items. */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "localAgent.chat";
  private view?: vscode.WebviewView;
  private turns: Turn[];
  private mode: Mode = "agent";
  private models: string[] = [];
  private running?: AbortController;
  private context?: { used: number; total: number };
  private planDecision?: (todos: string[] | null) => void;
  private pendingAnswer?: (text: string | null) => void;
  private approvals = new Map<string, { item: Extract<Item, { kind: "approval" }>; req: ApprovalRequest; resolve: (a: Approval) => void }>();
  /** Session permissions (reset by New chat), like Claude Code's "don't ask again". */
  private autoAccept = false;
  private allowedCommands = new Set<string>();
  private postTimer?: NodeJS.Timeout;
  private fileCache?: { at: number; files: string[] };
  private markReady!: () => void;
  /** Resolves once the webview app has loaded and said hello (used by the smoke test). */
  readonly ready = new Promise<void>((r) => (this.markReady = r));

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly backend: ChatBackend) {
    this.turns = ctx.workspaceState.get<Turn[]>(HISTORY_KEY, []).map((t) => ({ ...t, running: false }));
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const dist = vscode.Uri.joinPath(this.ctx.extensionUri, "dist", "webview");
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    view.webview.html = this.html(view.webview, dist);
    view.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m));
  }

  /** Starts a run from a command (e.g. "Local Agent: Run Task"). */
  async submit(text: string, mode: Mode) {
    await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
    this.mode = mode;
    await this.send(text, mode);
  }

  cancel() {
    this.running?.abort();
    this.planDecision?.(null);
    this.pendingAnswer?.(null);
    for (const [id] of this.approvals) this.decide(id, "no");
  }

  private async onMessage(m: FromWebview) {
    switch (m.type) {
      case "ready":
        this.markReady();
        this.models = await this.backend.listModels().catch(() => []);
        return this.postState();
      case "send":
        return this.send(m.text, m.mode);
      case "runPlan": {
        const plan = this.turns.find((t) => t.id === m.turnId)?.items.find((i) => i.kind === "plan");
        if (plan?.kind === "plan") return this.send("Run the plan.", "agent", { goal: plan.goal, todos: plan.todos });
        return;
      }
      case "approval":
        return this.decide(m.id, m.decision, m.feedback);
      case "openDiff": {
        const a = this.approvals.get(m.id);
        if (a?.req.kind === "edit") await this.backend.openDiff(a.req.path, a.req.before, a.req.after);
        return;
      }
      case "setAutoAccept":
        this.autoAccept = m.on;
        return this.postState();
      case "cancel":
        return this.cancel();
      case "newChat":
        if (this.running) return;
        this.turns = [];
        this.autoAccept = false;
        this.allowedCommands.clear();
        this.persist();
        return this.postState();
      case "setModel":
        await this.backend.setModel(m.model);
        return this.postState();
      case "setMode":
        this.mode = m.mode;
        return this.postState();
      case "answer":
        this.pendingAnswer?.(m.text);
        this.pendingAnswer = undefined;
        return;
      case "planDecision":
        this.planDecision?.(m.todos);
        this.planDecision = undefined;
        return;
      case "restore": {
        const ok = await vscode.window.showWarningMessage("Restore the workspace to the state before this message? The current state is saved as a checkpoint first.", { modal: true }, "Restore");
        if (ok === "Restore") {
          await this.backend.restore(m.checkpoint);
          vscode.window.showInformationMessage("Local Agent: workspace restored.");
        }
        return;
      }
      case "applyCode":
        return this.backend.applyCode(m.code);
      case "openFile": {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (folder) await vscode.window.showTextDocument(vscode.Uri.joinPath(folder.uri, m.path));
        return;
      }
      case "mentionQuery":
        return this.post({ type: "mentionResults", items: await this.mentionItems(m.query) });
    }
  }

  private async send(text: string, mode: Mode, plan?: RunOptions["plan"]) {
    if (this.running || !text.trim()) return;
    if (!plan && mode !== "ask") {
      plan = pendingPlanFor(this.turns, text);
      if (plan) mode = "agent";
    }
    const conversation = conversationText(this.turns);
    const turn: Turn = { id: String(Date.now()), items: [{ kind: "user", text, mode }], running: true };
    this.turns.push(turn);
    if (this.turns.length > MAX_TURNS) this.turns.splice(0, this.turns.length - MAX_TURNS);
    const abort = new AbortController();
    this.running = abort;
    this.postState();
    try {
      await this.backend.run(text, mode, {
        signal: abort.signal,
        onEvent: (e) => this.onEvent(turn, e),
        askUser: (question) =>
          new Promise((resolve) => {
            const item: Item = { kind: "question", text: question };
            turn.items.push(item);
            this.pendingAnswer = (text) => {
              if (item.kind === "question") item.answer = text?.trim() || null;
              this.postState();
              resolve(text?.trim() || undefined);
            };
            this.postState();
          }),
        approve: (req) => this.approve(turn, req),
        reviewPlan: (todos) =>
          new Promise((resolve) => {
            this.planDecision = (t) => resolve(t ?? undefined);
            const plan = turn.items.find((i) => i.kind === "plan");
            this.post({ type: "planReview", todos, goal: plan?.kind === "plan" ? plan.goal : undefined });
          }),
      }, { conversation, plan });
    } catch (e) {
      turn.items.push({ kind: "error", text: (e as Error).message });
    } finally {
      turn.running = false;
      this.running = undefined;
      turn.items = turn.items.filter((i) => i.kind !== "status");
      this.persist();
      this.postState();
    }
  }

  /** Edit/command permission, as a card in the conversation. */
  private approve(turn: Turn, req: ApprovalRequest): Promise<Approval> {
    if (req.kind === "edit" && this.autoAccept) return Promise.resolve({ ok: true });
    if (req.kind === "command" && this.allowedCommands.has(commandPrefix(req.command))) return Promise.resolve({ ok: true });
    const id = `${turn.id}-${this.approvals.size}-${Date.now()}`;
    const item: Extract<Item, { kind: "approval" }> =
      req.kind === "edit"
        ? { kind: "approval", id, action: req.isNew ? "create" : "edit", target: req.path, detail: unifiedDiff(req.before, req.after).slice(0, 20_000), state: "pending" }
        : { kind: "approval", id, action: "command", target: req.command, detail: req.reason, state: "pending" };
    turn.items.push(item);
    this.postState();
    return new Promise((resolve) => this.approvals.set(id, { item, req, resolve }));
  }

  private decide(id: string, decision: "yes" | "always" | "no", feedback?: string) {
    const a = this.approvals.get(id);
    if (!a) return;
    this.approvals.delete(id);
    a.item.state = decision;
    a.item.feedback = feedback?.trim() || undefined;
    if (decision === "always") {
      if (a.req.kind === "edit") this.autoAccept = true;
      else this.allowedCommands.add(commandPrefix(a.req.command));
    }
    a.resolve({ ok: decision !== "no", feedback: a.item.feedback });
    this.postState();
  }

  private onEvent(turn: Turn, e: AgentEvent) {
    if (e.type === "streaming") return this.post({ type: "streaming", thought: e.thought, answer: e.answer });
    if (e.type === "tokens") this.context = { used: e.prompt + e.output, total: e.ctx };
    applyEvent(turn, e);
    this.schedulePost();
  }

  private async mentionItems(query: string) {
    const q = query.toLowerCase();
    const fixed = [
      { label: "problems", detail: "current errors and warnings" },
      { label: "git", detail: "uncommitted diff" },
      { label: "terminal", detail: "last terminal output" },
      { label: "symbol:", detail: "a class, function or method by name" },
    ].filter((i) => i.label.startsWith(q));
    const host = this.backend.host();
    if (!host) return fixed;
    if (!this.fileCache || Date.now() - this.fileCache.at > 30_000) this.fileCache = { at: Date.now(), files: await listFiles(host) };
    const files = this.fileCache.files
      .filter((f) => f.toLowerCase().includes(q))
      .sort((a, b) => a.length - b.length)
      .slice(0, 12)
      .map((f) => ({ label: f }));
    return [...fixed, ...files];
  }

  private state(): ViewState {
    return { turns: this.turns, models: this.models, model: this.backend.currentModel(), mode: this.mode, running: !!this.running, autoAccept: this.autoAccept, context: this.context };
  }

  private schedulePost() {
    if (this.postTimer) return;
    this.postTimer = setTimeout(() => {
      this.postTimer = undefined;
      this.postState();
    }, 50);
  }

  private postState() {
    this.post({ type: "state", state: this.state() });
  }

  private post(m: ToWebview) {
    void this.view?.webview.postMessage(m);
  }

  private persist() {
    void this.ctx.workspaceState.update(HISTORY_KEY, this.turns);
  }

  private html(webview: vscode.Webview, dist: vscode.Uri) {
    const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const js = webview.asWebviewUri(vscode.Uri.joinPath(dist, "index.js"));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(dist, "index.css"));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Local Agent</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" type="module" src="${js}"></script>
</body>
</html>`;
  }
}

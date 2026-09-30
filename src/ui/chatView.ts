import * as vscode from "vscode";
import type { AgentEvent, RunOptions, RunResult } from "../agent/loop";
import { listFiles } from "../context/repoMap";
import { expandSlashCommand, listSlashCommands } from "../context/slashCommands";
import type { McpHub } from "../mcp/hub";
import { MEMORY_PATH } from "../tools/memoryTool";
import { unifiedDiff } from "../edit/lineDiff";
import type { Approval, ApprovalRequest, Host } from "../host/types";
import type { FromWebview, Item, Mode, SessionInfo, ToWebview, Turn, ViewState } from "./protocol";
import { applyEvent, conversationText, pendingPlanFor, titleOf } from "./transcript";

/** MCP tools switched off in the /mcp menu (workspaceState). */
export const MCP_DISABLED_KEY = "localAgent.mcpDisabledTools";
const SESSIONS_KEY = "localAgent.sessions";
const CURRENT_KEY = "localAgent.currentSession";
/** Pre-0.2 single transcript; migrated into a session once. */
const LEGACY_HISTORY_KEY = "localAgent.chatHistory";
const MAX_SESSIONS = 30;
const MAX_TURNS = 50;

interface Session {
  id: string;
  title: string;
  updatedAt: number;
  turns: Turn[];
  /** Tokens in the last model call of this conversation (prompt + output). */
  contextUsed?: number;
}

/** "dotnet new webapi -n X" → "dotnet new": what "don't ask again" allows. */
function commandPrefix(cmd: string): string {
  return cmd.trim().split(/\s+/).slice(0, 2).join(" ");
}

/** "qwen2.5-coder" matches "qwen2.5-coder:latest"; tags otherwise must match exactly. */
export function sameModel(installed: string, wanted: string): boolean {
  const norm = (m: string) => (m.includes(":") ? m : `${m}:latest`);
  return norm(installed) === norm(wanted);
}

function newSession(): Session {
  return { id: String(Date.now()), title: "", updatedAt: Date.now(), turns: [] };
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
  /** Context window (tokens) of the current model's profile. */
  contextWindow(): number;
  setModel(model: string): Promise<void>;
  /** Server endpoint and whether models can be pulled (Ollama). */
  endpoint(): { url: string; canPull: boolean };
  /** Starts downloading a model in a terminal. */
  pullModel(model: string): void;
  restore(checkpoint: string): Promise<void>;
  applyCode(code: string): Promise<void>;
  host(): Host | undefined;
  /** Connected MCP servers of the active folder, if any are configured. */
  mcp(): McpHub | undefined;
}

/**
 * Sidebar chat. Owns the conversations (persisted in workspaceState, one active),
 * session permissions, and turns agent events into UI items.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = "localAgent.chat";
  private view?: vscode.WebviewView;
  private sessions: Session[];
  private session: Session;
  private mode: Mode = "agent";
  private models: string[] = [];
  private setup?: import("./protocol").SetupProblem;
  private running?: AbortController;
  private activeFile?: string;
  private planDecision?: (todos: string[] | null) => void;
  private pendingAnswer?: (text: string | null) => void;
  private approvals = new Map<string, { item: Extract<Item, { kind: "approval" }>; req: ApprovalRequest; resolve: (a: Approval) => void }>();
  /** Session permissions (reset by New chat), like Claude Code's "don't ask again". */
  private autoAccept = vscode.workspace.getConfiguration("localAgent").get("autoRunCommands", false);
  /** Commands run without asking too ("Run everything" mode). The command policy still blocks dangerous ones. */
  private autoRun = vscode.workspace.getConfiguration("localAgent").get("autoRunCommands", false);
  private allowedCommands = new Set<string>();
  private postTimer?: NodeJS.Timeout;
  private fileCache?: { at: number; files: string[] };
  private disposables: vscode.Disposable[] = [];
  private markReady!: () => void;
  /** Resolves once the webview app has loaded and said hello (used by the smoke test). */
  readonly ready = new Promise<void>((r) => (this.markReady = r));

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly backend: ChatBackend) {
    this.sessions = ctx.workspaceState.get<Session[]>(SESSIONS_KEY, []).map((s) => ({ ...s, turns: s.turns.map((t) => ({ ...t, running: false })) }));
    const legacy = ctx.workspaceState.get<Turn[]>(LEGACY_HISTORY_KEY);
    if (legacy?.length) {
      this.sessions.unshift({ id: legacy[0].id, title: titleOf(legacy), updatedAt: Date.now(), turns: legacy.map((t) => ({ ...t, running: false })) });
      void ctx.workspaceState.update(LEGACY_HISTORY_KEY, undefined);
    }
    const current = ctx.workspaceState.get<string>(CURRENT_KEY);
    this.session = this.sessions.find((s) => s.id === current) ?? newSession();
    this.activeFile = this.relativeActiveFile();
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        const next = this.relativeActiveFile();
        if (next === undefined && !vscode.window.activeTextEditor) return; // focus moved to the chat: keep the last file
        this.activeFile = next;
        this.postState();
      }),
    );
  }

  /** Current conversation's turns (read by the smoke test). */
  get turns(): Turn[] {
    return this.session.turns;
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const dist = vscode.Uri.joinPath(this.ctx.extensionUri, "dist", "webview");
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    view.webview.html = this.html(view.webview, dist);
    view.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m));
  }

  /** Starts a run from a command (e.g. "Agent Lolo: Run Task"). */
  async submit(text: string, mode: Mode) {
    await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
    this.mode = mode;
    await this.send(text, mode, undefined, true);
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
        return this.checkSetup();
      case "setup":
        if (m.action === "pull" && this.setup) this.backend.pullModel(this.setup.model);
        else if (m.action === "settings") await vscode.commands.executeCommand("workbench.action.openSettings", "localAgent");
        else return this.checkSetup();
        return;
      case "send":
        return this.send(m.text, m.mode, undefined, m.includeActiveFile ?? true, m.images);
      case "runPlan": {
        const plan = this.turns.find((t) => t.id === m.turnId)?.items.find((i) => i.kind === "plan");
        if (plan?.kind === "plan") return this.send("Run the plan.", "agent", { goal: plan.goal, todos: plan.todos }, false);
        return;
      }
      case "approval":
        return this.decide(m.id, m.decision, m.feedback);
      case "openDiff": {
        const a = this.approvals.get(m.id);
        if (a?.req.kind === "edit") await this.backend.openDiff(a.req.path, a.req.before, a.req.after);
        if (a?.req.kind === "edits") for (const f of a.req.files) await this.backend.openDiff(f.path, f.before, f.after);
        return;
      }
      case "setAutoAccept":
        this.autoAccept = m.on;
        return this.postState();
      case "setAutoRun":
        this.autoRun = m.on;
        return this.postState();
      case "cancel":
        return this.cancel();
      case "newChat":
        if (this.running) return;
        this.switchTo(newSession());
        return;
      case "openSession": {
        const s = this.sessions.find((x) => x.id === m.id);
        if (s && !this.running) this.switchTo(s);
        return;
      }
      case "deleteSession":
        this.sessions = this.sessions.filter((s) => s.id !== m.id);
        if (this.session.id === m.id && !this.running) this.switchTo(newSession());
        else this.persist();
        return this.postState();
      case "setModel":
        await this.backend.setModel(m.model);
        return this.checkSetup();
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
          vscode.window.showInformationMessage("Agent Lolo: workspace restored.");
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
      case "slashQuery": {
        const host = this.backend.host();
        const items = host ? await listSlashCommands(host, this.backend.mcp()).catch(() => []) : [];
        return this.post({ type: "slashResults", items: items.map((c) => ({ cmd: `/${c.name}`, hint: c.description })) });
      }
      case "mcpStatus":
        return this.showMcpStatus();
      case "pickFile": {
        const host = this.backend.host();
        if (!host) return;
        const files = await listFiles(host);
        const pick = await vscode.window.showQuickPick(files, { title: "Attach a file to the message", matchOnDescription: true });
        if (pick) this.post({ type: "insertText", text: `@${pick} ` });
        return;
      }
      case "command": {
        const target = { restoreCheckpoint: "localAgent.restoreCheckpoint", inlineEdit: "localAgent.inlineEdit" } as const;
        if (m.id === "openSettings") await vscode.commands.executeCommand("workbench.action.openSettings", "localAgent");
        else if (m.id === "openMemory") await this.openMemory();
        else await vscode.commands.executeCommand(target[m.id]);
        return;
      }
    }
  }

  /**
   * First-run check: is the server reachable, and is the configured model there?
   * The result is a banner with the fix (start Ollama / download / pick another model).
   */
  async checkSetup() {
    const { url, canPull } = this.backend.endpoint();
    const model = this.backend.currentModel();
    try {
      this.models = await this.backend.listModels();
      // OpenAI-compatible servers may not list models: only complain when they do.
      const has = this.models.some((m) => sameModel(m, model)) || (!canPull && !this.models.length);
      this.setup = has ? undefined : { problem: "no-model", model, endpoint: url, installed: this.models };
    } catch {
      this.models = [];
      this.setup = { problem: "no-server", model, endpoint: url, installed: [] };
    }
    this.postState();
  }

  private switchTo(s: Session) {
    this.session = s;
    this.allowedCommands.clear();
    void this.ctx.workspaceState.update(CURRENT_KEY, s.id);
    this.postState();
  }

  private async openMemory() {
    const host = this.backend.host();
    if (!host) return;
    const uri = vscode.Uri.file(`${host.root}/${MEMORY_PATH}`);
    if (!(await host.stat(MEMORY_PATH))) {
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode("# Project memory\n\nFacts Agent Lolo keeps between conversations (edit freely).\n\n"));
    }
    await vscode.window.showTextDocument(uri);
  }

  /** `/mcp`: server status, and which of their tools the agent may use (saved per workspace). */
  private async showMcpStatus() {
    const hub = this.backend.mcp();
    if (!hub) {
      const pick = await vscode.window.showInformationMessage("No MCP servers are configured. Add them to .agent/mcp.json or the localAgent.mcpServers setting.", "Open settings");
      if (pick) await vscode.commands.executeCommand("workbench.action.openSettings", "localAgent.mcpServers");
      return;
    }
    await hub.ready();
    const all = hub.allTools();
    if (!all.length) {
      const lines = hub.status().map((s) => (s.ok ? `✓ ${s.name}: no tools` : `✗ ${s.name}: ${s.error}`));
      void vscode.window.showInformationMessage(`MCP servers — ${lines.join(" · ")}`);
      return;
    }
    const items: (vscode.QuickPickItem & { tool?: string })[] = [];
    for (const s of hub.status()) {
      items.push({ label: s.ok ? s.name : `${s.name}: not connected (${s.error})`, kind: vscode.QuickPickItemKind.Separator });
      for (const t of all.filter((x) => x.mcp.server === s.name)) {
        items.push({
          label: t.mcp.tool,
          description: t.mcp.readOnly ? "read-only" : "asks before each call",
          detail: t.description.replace(/^\[MCP [^\]]*\]\s*/, ""),
          picked: !hub.disabled.has(t.name),
          tool: t.name,
        });
      }
    }
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      matchOnDetail: true,
      title: "MCP tools the agent may use",
      placeHolder: "Checked tools are offered when a task is about them; uncheck the ones you don't want",
    });
    if (!picked) return;
    const on = new Set(picked.map((p) => p.tool));
    hub.disabled = new Set(all.map((t) => t.name).filter((n) => !on.has(n)));
    await this.ctx.workspaceState.update(MCP_DISABLED_KEY, [...hub.disabled]);
  }

  private async send(text: string, mode: Mode, plan: RunOptions["plan"], includeActiveFile: boolean, images?: string[]) {
    if (this.running || (!text.trim() && !images?.length)) return;
    if (!text.trim()) text = "What does this screenshot show? If it shows a problem in this project, explain it.";
    // "/name args": a user command (.agent/commands) or MCP prompt, expanded before the agent sees it.
    let prompt = text;
    const host = this.backend.host();
    if (!plan && text.startsWith("/") && host) {
      const expanded = await expandSlashCommand(text, host, this.backend.mcp()).catch((e: Error) => `(${e.message})`);
      if (expanded === undefined && /^\/[\w-]+(:[\w.-]+)?(\s|$)/.test(text.trim())) {
        void vscode.window.showWarningMessage(`Unknown command ${text.trim().split(/\s/)[0]}. Commands are .md files in .agent/commands.`);
        return;
      }
      if (expanded) prompt = expanded;
    }
    if (!plan && mode !== "ask") {
      plan = pendingPlanFor(this.turns, text);
      if (plan) mode = "agent";
    }
    const conversation = conversationText(this.turns);
    const attached = includeActiveFile && this.activeFile ? [this.activeFile] : [];
    const turn: Turn = { id: String(Date.now()), items: [{ kind: "user", text, mode, context: attached, images: images?.length || undefined }], running: true };
    this.session.turns.push(turn);
    if (this.session.turns.length > MAX_TURNS) this.session.turns.splice(0, this.session.turns.length - MAX_TURNS);
    if (!this.sessions.includes(this.session)) this.sessions.unshift(this.session);
    this.persist();
    const abort = new AbortController();
    this.running = abort;
    this.postState();
    try {
      await this.backend.run(
        prompt,
        mode,
        {
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
        },
        { conversation, plan, excludeActiveFile: !includeActiveFile, images },
      );
    } catch (e) {
      turn.items.push({ kind: "error", text: (e as Error).message });
      void this.checkSetup();
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
    if (req.kind !== "command" && this.autoAccept) return Promise.resolve({ ok: true });
    if (req.kind === "command" && (this.autoRun || this.allowedCommands.has(commandPrefix(req.command)))) return Promise.resolve({ ok: true });
    const id = `${turn.id}-${this.approvals.size}-${Date.now()}`;
    const item: Extract<Item, { kind: "approval" }> =
      req.kind === "edit"
        ? { kind: "approval", id, action: req.isNew ? "create" : "edit", target: req.path, detail: unifiedDiff(req.before, req.after).slice(0, 20_000), state: "pending" }
        : req.kind === "edits"
          ? {
              kind: "approval",
              id,
              action: "edit",
              target: req.files.length === 1 ? req.files[0].path : `${req.files.length} files (${req.reason})`,
              // One section per file; "@@ path" renders like a hunk header.
              detail: req.files.map((f) => `@@ ${f.path}\n${unifiedDiff(f.before, f.after)}`).join("\n").slice(0, 20_000),
              state: "pending",
            }
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
      if (a.req.kind === "command") this.allowedCommands.add(commandPrefix(a.req.command));
      else this.autoAccept = true;
    }
    a.resolve({ ok: decision !== "no", feedback: a.item.feedback });
    this.postState();
  }

  private onEvent(turn: Turn, e: AgentEvent) {
    if (e.type === "streaming") return this.post({ type: "streaming", thought: e.thought, answer: e.answer });
    if (e.type === "tokens") this.session.contextUsed = e.prompt + e.output;
    applyEvent(turn, e);
    this.schedulePost();
  }

  private async mentionItems(query: string) {
    const q = query.toLowerCase();
    if (q.startsWith("mcp")) await this.backend.mcp()?.ready(); // resources are known once servers run
    const fixed = [
      { label: "problems", detail: "current errors and warnings" },
      { label: "git", detail: "uncommitted diff" },
      { label: "terminal", detail: "last terminal output" },
      { label: "symbol:", detail: "a class, function or method by name" },
      { label: "web", detail: "let the agent search the web (localAgent.web.search)" },
      { label: "docs:", detail: "README of an installed package, e.g. docs:express" },
      ...(this.backend.mcp()?.resources() ?? []).map((r) => ({ label: `mcp:${r.server}/${r.name.replace(/\s+/g, "-")}`, detail: r.description ?? r.uri })),
    ].filter((i) => i.label.toLowerCase().startsWith(q));
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

  private relativeActiveFile(): string | undefined {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.uri.scheme !== "file" || !vscode.workspace.getWorkspaceFolder(doc.uri)) return undefined;
    return vscode.workspace.asRelativePath(doc.uri, false);
  }

  private state(): ViewState {
    const sessions: SessionInfo[] = this.sessions
      .filter((s) => s.turns.length)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => ({ id: s.id, title: s.title || titleOf(s.turns) || "Untitled", updatedAt: s.updatedAt }));
    return {
      setup: this.setup,
      sessionId: this.session.id,
      title: this.session.title || titleOf(this.session.turns),
      sessions,
      turns: this.session.turns,
      activeFile: this.activeFile,
      models: this.models,
      model: this.backend.currentModel(),
      mode: this.mode,
      running: !!this.running,
      autoAccept: this.autoAccept,
      autoRun: this.autoRun,
      context: { used: this.session.contextUsed ?? 0, total: this.backend.contextWindow() },
    };
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
    this.session.updatedAt = Date.now();
    this.session.title ||= titleOf(this.session.turns);
    const keep = this.sessions
      .filter((s) => s.turns.length)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SESSIONS);
    this.sessions = keep;
    void this.ctx.workspaceState.update(SESSIONS_KEY, keep);
    void this.ctx.workspaceState.update(CURRENT_KEY, this.session.id);
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
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
<title>Agent Lolo</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" type="module" src="${js}"></script>
</body>
</html>`;
  }
}

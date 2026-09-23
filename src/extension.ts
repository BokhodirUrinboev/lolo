import * as vscode from "vscode";
import { Agent } from "./agent/loop";
import { FimProvider, FimSettings } from "./autocomplete/fimProvider";
import { Checkpoints } from "./edit/checkpoints";
import { DiffReviewManager } from "./edit/diffView";
import { VsCodeHost } from "./host/vscodeHost";
import { inlineEdit } from "./inline/inlineEdit";
import { createProvider, ProviderConfig } from "./providers";
import type { ProfileOverride } from "./providers/modelProfiles";
import { ChatBackend, ChatViewProvider } from "./ui/chatView";
import type { Mode } from "./ui/protocol";

const cfg = () => vscode.workspace.getConfiguration("localAgent");
const PROPOSED_SCHEME = "local-agent-proposed";

function providerConfig(model = cfg().get("model", "qwen2.5-coder-32k:latest")): ProviderConfig {
  const c = cfg();
  return {
    provider: c.get<"ollama" | "openai">("provider", "ollama"),
    endpoint: c.get("endpoint", "http://localhost:11434"),
    apiKey: c.get("apiKey", ""),
    model,
    profiles: c.get<ProfileOverride[]>("profiles", []),
  };
}

/** Exported for the integration smoke test. */
export interface LocalAgentApi {
  review: DiffReviewManager;
  chat: ChatViewProvider;
  chatReady: Promise<void>;
}

export function activate(context: vscode.ExtensionContext): LocalAgentApi {
  const output = vscode.window.createOutputChannel("Local Agent");
  const review = new DiffReviewManager();
  // Read-only documents for "Open diff" on approval cards.
  const proposed = new Map<string, string>();
  const hosts = new Map<string, VsCodeHost>();

  const hostFor = (folder: vscode.WorkspaceFolder) => {
    let h = hosts.get(folder.uri.toString());
    if (!h) {
      h = new VsCodeHost(folder, { autoApproveEdits: () => cfg().get("autoApproveEdits", false), review, output });
      hosts.set(folder.uri.toString(), h);
    }
    return h;
  };

  const backend: ChatBackend = {
    async run(text, mode, hooks, opts) {
      const folder = activeFolder();
      if (!folder) throw new Error("Open a folder first.");
      const provider = createProvider(providerConfig());
      const host = hostFor(folder);
      host.askHandler = hooks.askUser;
      host.approvalHandler = hooks.approve;
      const agent = new Agent({
        host,
        provider,
        commandAllowlist: cfg().get<string[]>("commandAllowlist", []),
        maxStepsPerTodo: cfg().get("maxStepsPerTodo", 15),
        onEvent: hooks.onEvent,
        reviewPlan: mode === "agent" && cfg().get("reviewPlan", false) ? hooks.reviewPlan : undefined,
      });
      hooks.signal.addEventListener("abort", () => void review.rejectAll());
      output.appendLine(`▶ ${mode} · ${provider.model}: ${text}`);
      const r = await agent.run(text, mode, hooks.signal, opts).finally(() => {
        host.askHandler = undefined;
        host.approvalHandler = undefined;
      });
      output.appendLine(`  ${r.status} · ${r.stats.steps} steps · ${(r.stats.ms / 1000).toFixed(1)}s · log ${r.logFile ?? "-"}`);
      return r;
    },
    listModels: () => listModels(providerConfig()),
    currentModel: () => cfg().get("model", "qwen2.5-coder-32k:latest"),
    setModel: (model) => Promise.resolve(cfg().update("model", model, vscode.ConfigurationTarget.Global)),
    async restore(checkpoint) {
      const folder = activeFolder();
      if (folder) await new Checkpoints(folder.uri.fsPath).restore(checkpoint);
    },
    applyCode: (code) => applyCode(review, code),
    async openDiff(path, before, after) {
      const folder = activeFolder();
      if (!folder) return;
      const stamp = Date.now();
      const left = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: `/${path}`, query: `before-${stamp}` });
      const right = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: `/${path}`, query: `after-${stamp}` });
      proposed.set(left.toString(), before);
      proposed.set(right.toString(), after);
      await vscode.commands.executeCommand("vscode.diff", left, right, `${path} (proposed change)`, { preview: true });
    },
    host: () => {
      const f = activeFolder();
      return f ? hostFor(f) : undefined;
    },
  };
  const chat = new ChatViewProvider(context, backend);

  const fimSettings = (): FimSettings => {
    const c = cfg();
    const model = c.get("autocomplete.model", "") || c.get("model", "qwen2.5-coder-32k:latest");
    return {
      enabled: c.get("autocomplete.enabled", true),
      debounceMs: c.get("autocomplete.debounceMs", 250),
      maxTokens: c.get("autocomplete.maxTokens", 128),
      provider: providerConfig(model),
    };
  };

  const ask = async (mode: Mode) => {
    const text = await vscode.window.showInputBox({ title: `Local Agent: ${mode === "agent" ? "Run Task" : mode === "ask" ? "Ask" : "Plan"}`, ignoreFocusOut: true });
    if (text?.trim()) await chat.submit(text.trim(), mode);
  };

  context.subscriptions.push(
    output,
    review,
    { dispose: () => hosts.forEach((h) => h.dispose()) },
    vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, { provideTextDocumentContent: (uri) => proposed.get(uri.toString()) ?? "" }),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chat, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, new FimProvider(fimSettings, output)),
    vscode.commands.registerCommand("localAgent.runTask", () => ask("agent")),
    vscode.commands.registerCommand("localAgent.ask", () => ask("ask")),
    vscode.commands.registerCommand("localAgent.plan", () => ask("plan")),
    vscode.commands.registerCommand("localAgent.cancel", () => chat.cancel()),
    vscode.commands.registerCommand("localAgent.inlineEdit", () => inlineEdit(review, () => createProvider(providerConfig()))),
    vscode.commands.registerCommand("localAgent.restoreCheckpoint", restoreCheckpoint),
    vscode.commands.registerCommand("localAgent.toggleAutocomplete", async () => {
      const on = !cfg().get("autocomplete.enabled", true);
      await cfg().update("autocomplete.enabled", on, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Local Agent autocomplete ${on ? "enabled" : "disabled"}.`);
    }),
  );
  return { review, chat, chatReady: chat.ready };
}

function activeFolder(): vscode.WorkspaceFolder | undefined {
  const editor = vscode.window.activeTextEditor;
  return (editor && vscode.workspace.getWorkspaceFolder(editor.document.uri)) ?? vscode.workspace.workspaceFolders?.[0];
}

async function listModels(p: ProviderConfig): Promise<string[]> {
  const base = p.endpoint.replace(/\/$/, "");
  const headers: Record<string, string> = p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {};
  const res = await fetch(p.provider === "ollama" ? `${base}/api/tags` : `${base}/models`, { headers, signal: AbortSignal.timeout(3000) });
  const json = (await res.json()) as { models?: { name: string }[]; data?: { id: string }[] };
  return p.provider === "ollama" ? (json.models ?? []).map((m) => m.name) : (json.data ?? []).map((m) => m.id);
}

/** "Apply" on a chat code block: replaces the selection (or inserts at the cursor) as an inline diff. */
async function applyCode(review: DiffReviewManager, code: string) {
  const editor = vscode.window.visibleTextEditors.find((e) => e === vscode.window.activeTextEditor) ?? vscode.window.visibleTextEditors[0];
  if (!editor) {
    vscode.window.showWarningMessage("Local Agent: open a file and select the code to replace first.");
    return;
  }
  const doc = editor.document;
  const full = doc.getText();
  const sel = editor.selection;
  const range = sel.isEmpty ? new vscode.Range(sel.active, sel.active) : new vscode.Range(sel.start.line, 0, sel.end.line, doc.lineAt(sel.end.line).text.length);
  const start = doc.offsetAt(range.start);
  const end = doc.offsetAt(range.end);
  await review.review(doc.uri, full, full.slice(0, start) + code + full.slice(end), { save: false });
}

async function restoreCheckpoint() {
  const folder = activeFolder();
  if (!folder) return;
  const cp = new Checkpoints(folder.uri.fsPath);
  const list = await cp.list();
  if (!list.length) {
    vscode.window.showInformationMessage("No checkpoints yet.");
    return;
  }
  const pick = await vscode.window.showQuickPick(
    list.map((c) => ({ label: c.label, description: `${c.id.slice(0, 8)} · ${c.time.toLocaleString()}`, id: c.id })),
    { title: "Restore workspace to checkpoint" },
  );
  if (!pick) return;
  const ok = await vscode.window.showWarningMessage(`Restore files to "${pick.label}"? The current state is saved as a checkpoint first.`, { modal: true }, "Restore");
  if (ok !== "Restore") return;
  await cp.restore(pick.id);
  vscode.window.showInformationMessage(`Restored to ${pick.description}.`);
}

export function deactivate() {}

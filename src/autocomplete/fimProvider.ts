import * as vscode from "vscode";
import { createProvider, ProviderConfig } from "../providers";
import type { LLMProvider } from "../providers/types";
import { buildFimPrompt, CompletionCache, postprocessCompletion } from "./fim";
import { importContext } from "./importContext";

const PREFIX_CHARS = 4000;
const SUFFIX_CHARS = 1500;

export interface FimSettings {
  enabled: boolean;
  debounceMs: number;
  maxTokens: number;
  provider: ProviderConfig;
}

/** Inline (ghost text) completions via the model's native FIM tokens. */
export class FimProvider implements vscode.InlineCompletionItemProvider {
  private cache = new CompletionCache();
  private inflight?: AbortController;
  private provider?: { key: string; value: LLMProvider };

  constructor(private readonly settings: () => FimSettings, private readonly output: vscode.OutputChannel) {}

  async provideInlineCompletionItems(
    doc: vscode.TextDocument,
    pos: vscode.Position,
    _ctx: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const cfg = this.settings();
    if (!cfg.enabled || doc.uri.scheme !== "file") return undefined;
    const provider = this.getProvider(cfg.provider);
    const fim = provider.profile.fim;
    if (!fim) return undefined;

    const text = doc.getText();
    const offset = doc.offsetAt(pos);
    const prefix = text.slice(Math.max(0, offset - PREFIX_CHARS), offset);
    const suffix = text.slice(offset, offset + SUFFIX_CHARS);
    const cached = this.cache.get(prefix, suffix);
    if (cached) return [new vscode.InlineCompletionItem(cached, new vscode.Range(pos, pos))];

    // Debounce: VS Code cancels the token when the user keeps typing.
    await new Promise((r) => setTimeout(r, cfg.debounceMs));
    if (token.isCancellationRequested) return undefined;
    this.inflight?.abort();
    const abort = new AbortController();
    this.inflight = abort;
    token.onCancellationRequested(() => abort.abort());

    const midLine = !!suffix.split("\n")[0].trim();
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const context = await importContext(
      doc.uri.fsPath,
      text,
      async (abs) => {
        try {
          return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(abs)));
        } catch {
          return undefined;
        }
      },
      (abs) => (folder ? vscode.workspace.asRelativePath(abs, false) : abs),
    );
    const relPath = folder ? vscode.workspace.asRelativePath(doc.uri, false) : doc.fileName;
    const t0 = Date.now();
    try {
      const raw = await provider.complete({
        prompt: buildFimPrompt(fim, { path: relPath, prefix, suffix, context }),
        maxTokens: midLine ? 48 : cfg.maxTokens,
        temperature: 0.1,
        stop: [...(fim.stop ?? []), ...(midLine ? ["\n"] : [])],
        signal: abort.signal,
      });
      const completion = postprocessCompletion(raw, prefix, suffix);
      this.output.appendLine(`[fim] ${Date.now() - t0}ms ${relPath}:${pos.line + 1} ${JSON.stringify(completion.slice(0, 60))}`);
      if (!completion || token.isCancellationRequested) return undefined;
      this.cache.set(prefix, suffix, completion);
      return [new vscode.InlineCompletionItem(completion, new vscode.Range(pos, pos))];
    } catch (e) {
      if ((e as Error).name !== "AbortError") this.output.appendLine(`[fim] error: ${(e as Error).message}`);
      return undefined;
    } finally {
      if (this.inflight === abort) this.inflight = undefined;
    }
  }

  private getProvider(cfg: ProviderConfig): LLMProvider {
    const key = JSON.stringify(cfg);
    if (this.provider?.key !== key) this.provider = { key, value: createProvider(cfg) };
    return this.provider.value;
  }
}

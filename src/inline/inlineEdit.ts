import * as vscode from "vscode";
import type { DiffReviewManager } from "../edit/diffView";
import type { LLMProvider } from "../providers/types";
import { extractCode, inlineEditMessages, matchIndent } from "./inlineEditPrompt";

/**
 * Ctrl+I: rewrite the selection (or the current line) from an instruction. The
 * result appears as an inline diff; Tab accepts, Esc rejects (or per-hunk CodeLens).
 */
export async function inlineEdit(review: DiffReviewManager, getProvider: () => LLMProvider) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const doc = editor.document;
  let range: vscode.Range = editor.selection;
  if (editor.selection.isEmpty) range = doc.lineAt(editor.selection.active.line).range;
  // Whole lines: models rewrite blocks, not fragments.
  range = new vscode.Range(range.start.line, 0, range.end.line, doc.lineAt(range.end.line).text.length);
  const selection = doc.getText(range);

  const instruction = await vscode.window.showInputBox({ title: "Local Agent: Edit selection", prompt: "Describe the change", ignoreFocusOut: true });
  if (!instruction?.trim()) return;

  const provider = getProvider();
  const full = doc.getText();
  const start = doc.offsetAt(range.start);
  const end = doc.offsetAt(range.end);
  const messages = inlineEditMessages({
    path: vscode.workspace.asRelativePath(doc.uri, false),
    language: doc.languageId,
    before: full.slice(0, start),
    selection,
    after: full.slice(end),
    instruction,
  });

  const reply = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Local Agent: editing (${provider.model})`, cancellable: true },
    async (_p, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());
      try {
        return (await provider.chat({ messages, signal: abort.signal, temperature: 0.1 })).content;
      } catch (e) {
        if (!abort.signal.aborted) vscode.window.showErrorMessage(`Local Agent: ${(e as Error).message}`);
        return undefined;
      }
    },
  );
  if (!reply) return;
  const code = matchIndent(extractCode(reply), selection);
  if (code === selection) {
    vscode.window.showInformationMessage("Local Agent: no change suggested.");
    return;
  }
  // The document may have changed while we waited; rebuild from its current text.
  const now = doc.getText();
  if (now !== full) {
    vscode.window.showWarningMessage("Local Agent: the file changed while generating; edit discarded.");
    return;
  }
  await review.review(doc.uri, full, full.slice(0, start) + code + full.slice(end), { save: false });
}

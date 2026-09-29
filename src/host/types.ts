import type { EditorContext } from "../context/collectors";
import type { SymbolLocation } from "../context/mentions";

/**
 * Everything the agent core needs from its environment. The core never imports
 * `vscode`; VsCodeHost and NodeHost (headless: CLI, eval, tests) implement this.
 * All paths are workspace-relative with forward slashes.
 */
export interface Host {
  readonly root: string;
  /** Whether a person can answer ask_user/confirm right now. */
  readonly interactive: boolean;
  readFile(path: string): Promise<string>;
  /** "file" | "dir" | null when missing. */
  stat(path: string): Promise<"file" | "dir" | null>;
  listDir(path: string): Promise<{ name: string; type: "file" | "dir" }[]>;
  /**
   * Shows the change for review (unless auto-approved) and writes it through the
   * editor so native undo works. Resolves to whether it was applied.
   */
  proposeWrite(path: string, content: string, info: { isNew: boolean; reason: string }): Promise<WriteOutcome>;
  /** Several writes reviewed together with one approval (e.g. a rename across files). */
  proposeWrites(changes: FileChange[], reason: string): Promise<WriteOutcome>;
  /** Renames/moves a file or folder (creating parent folders) after asking the user; imports may be updated by the editor. */
  moveFile(from: string, to: string): Promise<WriteOutcome>;
  /** Deletes a file or folder after asking the user. */
  deleteFile(path: string): Promise<WriteOutcome>;
  /** Errors and warnings; for the given files, or the whole workspace. */
  diagnostics(paths?: string[]): Promise<Diagnostic[]>;
  /** Runs a shell command. `cwd` is workspace-relative; on timeout the command is stopped and `timedOut` set. */
  runCommand(command: string, signal?: AbortSignal, opts?: { cwd?: string; timeoutMs?: number }): Promise<CommandResult>;
  confirm(message: string): Promise<boolean>;
  /** Asks to run a command that is not allowlisted. `always` = allow this command for the rest of the session. */
  approveCommand?(command: string, reason: string): Promise<Approval>;
  askUser(question: string): Promise<string | undefined>;
  /** Active file, selection, tabs, terminal; absent in headless hosts. */
  editorContext?(): Promise<EditorContext | undefined>;
  /** Workspace symbol search (LSP); headless hosts fall back to tree-sitter. */
  workspaceSymbols?(query: string): Promise<SymbolLocation[]>;
  /** LSP references of the symbol at `pos` (including its declaration); undefined when no language server answers. */
  references?(pos: SourcePos): Promise<SourcePos[] | undefined>;
  /** LSP rename of the symbol at `pos`: the new content of each changed file, not applied yet. undefined when no language server can rename it. */
  renameEdits?(pos: SourcePos, newName: string): Promise<FileChange[] | undefined>;
  /** Path to a ripgrep binary, if the host knows one. */
  rgPath?(): string | undefined;
}

/** A position in a workspace file: 1-based line, 0-based column. */
export interface SourcePos {
  path: string;
  line: number;
  column: number;
}

export interface FileChange {
  path: string;
  content: string;
}

/** Something the user must approve (shown as a card in the chat). */
export type ApprovalRequest =
  | { kind: "edit"; path: string; isNew: boolean; reason: string; before: string; after: string }
  | { kind: "edits"; reason: string; files: { path: string; before: string; after: string }[] }
  | { kind: "command"; command: string; reason: string };

export interface Approval {
  ok: boolean;
  /** "No, do this instead": passed to the model. */
  feedback?: string;
}

export interface WriteOutcome {
  applied: boolean;
  /** Applied: e.g. "user accepted 2 of 3 hunks". Rejected: the user's feedback, if any. */
  note?: string;
}

export interface Diagnostic {
  path: string;
  line: number; // 1-based
  severity: "error" | "warning";
  message: string;
}

export interface CommandResult {
  exitCode: number;
  output: string;
  timedOut?: boolean;
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

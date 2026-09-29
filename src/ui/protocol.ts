/** Messages between the extension (ChatViewProvider) and the React webview. Plain JSON only. */

export type Mode = "ask" | "agent" | "plan";

export type Item =
  | { kind: "user"; text: string; mode: Mode; /** Files attached as context (e.g. the active editor). */ context?: string[]; /** Number of pasted images (not stored). */ images?: number }
  | { kind: "status"; text: string }
  | { kind: "plan"; goal?: string; todos: string[]; states: ("pending" | "active" | "done" | "failed")[] }
  | { kind: "thought"; text: string }
  | { kind: "tool"; tool: string; /** Path, command or query the call acted on. */ target?: string; title: string; ok: boolean; output: string }
  | { kind: "invalid"; text: string }
  | { kind: "verify"; ok: boolean; output: string }
  | { kind: "question"; text: string; answer?: string | null }
  | {
      kind: "approval";
      id: string;
      action: "edit" | "create" | "command";
      /** File path or command line. */
      target: string;
      /** Unified diff (edits) or the reason approval is needed (commands). */
      detail: string;
      state: "pending" | "yes" | "always" | "no";
      feedback?: string;
    }
  | { kind: "result"; status: string; summary: string; changed: string[]; checkpoint?: string; stats: string }
  | { kind: "error"; text: string };

export interface Turn {
  id: string;
  items: Item[];
  running: boolean;
}

export interface SessionInfo {
  id: string;
  title: string;
  updatedAt: number;
}

/** Why the chat can't work yet, shown as a banner with a fix. */
export interface SetupProblem {
  problem: "no-server" | "no-model";
  model: string;
  endpoint: string;
  /** Models the server has (for "use this one instead"). */
  installed: string[];
}

export interface ViewState {
  setup?: SetupProblem;
  sessionId: string;
  /** Current conversation title (first message), "" for a new chat. */
  title: string;
  /** Past conversations, newest first (history menu). */
  sessions: SessionInfo[];
  turns: Turn[];
  /** Workspace-relative path of the active editor, offered as context. */
  activeFile?: string;
  models: string[];
  model: string;
  mode: Mode;
  running: boolean;
  /** Session setting: apply edits without asking. */
  autoAccept: boolean;
  /** Tokens of the conversation's last model call vs the model's context window (always set). */
  context?: { used: number; total: number };
}

export type ToWebview =
  | { type: "state"; state: ViewState }
  | { type: "streaming"; thought: string; answer?: string }
  | { type: "planReview"; todos: string[]; goal?: string }
  | { type: "mentionResults"; items: { label: string; detail?: string }[] }
  /** User commands (.agent/commands, MCP prompts) for the "/" menu. */
  | { type: "slashResults"; items: { cmd: string; hint: string }[] }
  | { type: "insertText"; text: string };

export type FromWebview =
  | { type: "ready" }
  | { type: "send"; text: string; mode: Mode; includeActiveFile?: boolean; /** Pasted images, base64 without the data: prefix. */ images?: string[] }
  | { type: "openSession"; id: string }
  | { type: "deleteSession"; id: string }
  | { type: "pickFile" }
  | { type: "setup"; action: "retry" | "pull" | "settings" }
  | { type: "command"; id: "restoreCheckpoint" | "openSettings" | "inlineEdit" | "openMemory" }
  | { type: "cancel" }
  | { type: "newChat" }
  | { type: "setModel"; model: string }
  | { type: "setMode"; mode: Mode }
  | { type: "planDecision"; todos: string[] | null }
  | { type: "answer"; text: string | null }
  | { type: "approval"; id: string; decision: "yes" | "always" | "no"; feedback?: string }
  | { type: "openDiff"; id: string }
  | { type: "setAutoAccept"; on: boolean }
  | { type: "runPlan"; turnId: string }
  | { type: "restore"; checkpoint: string }
  | { type: "applyCode"; code: string }
  | { type: "openFile"; path: string }
  | { type: "mentionQuery"; query: string }
  | { type: "slashQuery" }
  | { type: "mcpStatus" };

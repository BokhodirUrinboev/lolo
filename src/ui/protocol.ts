/** Messages between the extension (ChatViewProvider) and the React webview. Plain JSON only. */

export type Mode = "ask" | "agent" | "plan";

export type Item =
  | { kind: "user"; text: string; mode: Mode }
  | { kind: "status"; text: string }
  | { kind: "plan"; goal?: string; todos: string[]; states: ("pending" | "active" | "done" | "failed")[] }
  | { kind: "thought"; text: string }
  | { kind: "tool"; tool: string; title: string; ok: boolean; output: string }
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

export interface ViewState {
  turns: Turn[];
  models: string[];
  model: string;
  mode: Mode;
  running: boolean;
  /** Session setting: apply edits without asking. */
  autoAccept: boolean;
  /** Prompt tokens of the last model call vs the context window. */
  context?: { used: number; total: number };
}

export type ToWebview =
  | { type: "state"; state: ViewState }
  | { type: "streaming"; thought: string; answer?: string }
  | { type: "planReview"; todos: string[]; goal?: string }
  | { type: "mentionResults"; items: { label: string; detail?: string }[] };

export type FromWebview =
  | { type: "ready" }
  | { type: "send"; text: string; mode: Mode }
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
  | { type: "mentionQuery"; query: string };

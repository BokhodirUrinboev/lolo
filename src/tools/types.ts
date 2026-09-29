import type { EditState } from "../edit/formats";
import type { Host } from "../host/types";
import type { ModelProfile } from "../providers/modelProfiles";
import type { SemanticIndex } from "../context/semanticIndex";
import type { WebConfig } from "../web/search";
import type { ProcessManager } from "./processes";
import type { Schema } from "./validate";

export interface ToolContext {
  host: Host;
  profile: ModelProfile;
  edits: EditState;
  commandAllowlist: string[];
  signal?: AbortSignal;
  /** Answering a question: no edit hints, no write tools. */
  readOnly?: boolean;
  /** Optional tool groups enabled for the current todo (see agent/needs.ts). */
  needs?: Set<ToolGroup>;
  /** A file longer than the whole-file limit was read; unlocks the "symbols" group. */
  largeFiles?: boolean;
  /** Background processes of this run (start_process); stopped when the run ends. */
  processes?: ProcessManager;
  /** Embedding index, when an embedding model is configured (semantic_search). */
  semantic?: SemanticIndex;
  /** Web search settings; web tools are hidden when unset. */
  web?: WebConfig;
  /** Reduces a long text to the parts relevant to `question` with a separate model call (fetch_url). */
  extract?: (text: string, question: string, signal?: AbortSignal) => Promise<string>;
  /** MCP tools chosen for the current todo (mcp/select.ts). */
  mcpTools?: Set<string>;
  /** Runs a read-only sub-agent on a question and returns its answer (explore tool). */
  explore?: (question: string, signal?: AbortSignal) => Promise<string>;
  /** The workspace has many code files (explore is offered for todos that name no file). */
  largeRepo?: boolean;
  /** Text of the todo being worked on. */
  todo?: string;
  /** Renames done by rename_symbol in this run (old → new): later todos about the same rename are already done. */
  renamed?: Map<string, string>;
}

export interface ToolResult {
  ok: boolean;
  /** Full observation shown to the model on this step. */
  output: string;
  /** One-line version kept in history after compaction. */
  summary: string;
  /** Workspace-relative files this call wrote. */
  changed?: string[];
  /** A write whose content equals the current file (not an apply failure). */
  noop?: boolean;
}

/** read: always allowed · write: goes through diff review · exec: command policy · control: handled by the loop. */
export type ToolKind = "read" | "write" | "exec" | "control";

/** Tools that are offered only for todos that need them; every tool in the schema is another chance for a small model to pick wrong. */
export type ToolGroup = "git" | "fileops" | "symbols" | "refactor" | "process" | "web" | "mcp" | "memory" | "explore";

export interface ToolDef<A = any> {
  name: string;
  kind: ToolKind;
  /** Set for optional tools; absent for the always-on set. */
  group?: ToolGroup;
  /** Needs something the run may not have (an embedding model, ...); the tool is hidden when false. */
  available?(ctx: ToolContext): boolean;
  /** One or two lines for the system prompt. */
  description: string;
  params: Schema & { type: "object" };
  /** Semantic checks beyond the schema (file exists, format policy, ...). Returns an error message. */
  check?(args: A, ctx: ToolContext): Promise<string | undefined>;
  run(args: A, ctx: ToolContext): Promise<ToolResult>;
}

export const ok = (output: string, summary: string, changed?: string[]): ToolResult => ({ ok: true, output, summary, changed });
export const fail = (output: string, summary = output.split("\n")[0]): ToolResult => ({ ok: false, output, summary });

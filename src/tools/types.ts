import type { EditState } from "../edit/formats";
import type { Host } from "../host/types";
import type { ModelProfile } from "../providers/modelProfiles";
import type { Schema } from "./validate";

export interface ToolContext {
  host: Host;
  profile: ModelProfile;
  edits: EditState;
  commandAllowlist: string[];
  signal?: AbortSignal;
  /** Answering a question: no edit hints, no write tools. */
  readOnly?: boolean;
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

export interface ToolDef<A = any> {
  name: string;
  kind: ToolKind;
  /** One or two lines for the system prompt. */
  description: string;
  params: Schema & { type: "object" };
  /** Semantic checks beyond the schema (file exists, format policy, ...). Returns an error message. */
  check?(args: A, ctx: ToolContext): Promise<string | undefined>;
  run(args: A, ctx: ToolContext): Promise<ToolResult>;
}

export const ok = (output: string, summary: string, changed?: string[]): ToolResult => ({ ok: true, output, summary, changed });
export const fail = (output: string, summary = output.split("\n")[0]): ToolResult => ({ ok: false, output, summary });

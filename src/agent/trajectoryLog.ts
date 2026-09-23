import { appendFileSync } from "node:fs";
import * as path from "node:path";
import { ensureAgentDir } from "../edit/agentDir";
import type { ChatMessage } from "../providers/types";

/**
 * JSONL log of a run: every model call, action and result. Used for eval metrics
 * and as a fine-tuning dataset. Model calls store only messages that differ from
 * the previous call (`from` = index of the first new message) to keep files linear.
 */
export class TrajectoryLog {
  readonly file: string;
  private lastMessages: ChatMessage[] = [];

  constructor(root: string, readonly runId: string) {
    const dir = ensureAgentDir(root, "trajectories");
    this.file = path.join(dir, `${runId}.jsonl`);
  }

  write(type: string, data: object) {
    appendFileSync(this.file, JSON.stringify({ t: new Date().toISOString(), type, ...data }) + "\n");
  }

  llm(kind: string, messages: ChatMessage[], response: string, meta: object) {
    let from = 0;
    while (from < messages.length && from < this.lastMessages.length && sameMessage(messages[from], this.lastMessages[from])) from++;
    this.lastMessages = messages;
    this.write("llm", { kind, from, messages: messages.slice(from), response, ...meta });
  }
}

function sameMessage(a: ChatMessage, b: ChatMessage) {
  return a.role === b.role && a.content === b.content;
}

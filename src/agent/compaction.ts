import { estimateTokens } from "../context/budget";
import type { ChatMessage } from "../providers/types";

export interface Turn {
  assistant: string;
  /** Full observation text. */
  observation: string;
  /** One-line observation used once the turn is compacted. */
  summary: string;
  compacted: boolean;
}

/** Recent turns kept verbatim when compacting. */
export const KEEP_RECENT = 3;

/**
 * Conversation history as assistant/observation turns. Compaction replaces old
 * observations with their one-line summary, and only runs when the budget is
 * exceeded, so the prompt prefix stays byte-identical (KV-cache friendly) between
 * compactions.
 */
export class History {
  private preamble: ChatMessage[] = [];
  private turns: Turn[] = [];
  /** Text to prepend to the next observation (todo switches, warnings). */
  private pendingNote = "";

  /** Messages that are never compacted (the plan exchange). */
  setPreamble(messages: ChatMessage[]) {
    this.preamble = messages;
  }

  add(assistant: string, observation: string, summary = observation.split("\n")[0]) {
    const note = this.pendingNote;
    this.pendingNote = "";
    this.turns.push({ assistant, observation: note ? `${observation}\n\n${note}` : observation, summary: note ? `${summary}\n${note}` : summary, compacted: false });
  }

  /** Attaches a note to the conversation: to the last observation if it is still the tail, else queued. */
  note(text: string) {
    const last = this.turns[this.turns.length - 1];
    if (last && !last.compacted) {
      last.observation += `\n\n${text}`;
      last.summary += `\n${text}`;
    } else if (!this.turns.length && this.preamble.length) {
      this.preamble = [...this.preamble, { role: "user", content: text }];
    } else {
      this.pendingNote = this.pendingNote ? `${this.pendingNote}\n${text}` : text;
    }
  }

  messages(): ChatMessage[] {
    const out = [...this.preamble];
    for (const t of this.turns) {
      out.push({ role: "assistant", content: t.assistant });
      out.push({ role: "user", content: t.compacted ? `[compacted] ${t.summary}` : t.observation });
    }
    return mergeConsecutive(out);
  }

  tokens(): number {
    return this.messages().reduce((n, m) => n + estimateTokens(m.content), 0);
  }

  /** Compacts old turns if over `budget`; returns how many were compacted. */
  compactIfNeeded(budget: number): number {
    if (this.tokens() <= budget) return 0;
    let n = 0;
    for (let i = 0; i < this.turns.length - KEEP_RECENT; i++) {
      if (!this.turns[i].compacted) {
        this.turns[i].compacted = true;
        n++;
      }
    }
    return n;
  }

  get length() {
    return this.turns.length;
  }
}

/** Some chat templates reject two user messages in a row. */
export function mergeConsecutive(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) {
      const images = [...(prev.images ?? []), ...(m.images ?? [])];
      out[out.length - 1] = { role: m.role, content: `${prev.content}\n\n${m.content}`, ...(images.length ? { images } : {}) };
    }
    else out.push({ ...m });
  }
  return out;
}

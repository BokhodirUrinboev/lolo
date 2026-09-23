import type { ChatMessage, LLMProvider } from "../providers/types";
import type { Schema } from "../tools/validate";
import { mergeConsecutive } from "./compaction";
import { PLAN_REQUEST } from "./prompts";

export const PLAN_SCHEMA: Schema = {
  type: "object",
  // Field order is generation order: restating the message in English (goal) before
  // classifying it makes small models classify non-English messages correctly.
  properties: {
    goal: { type: "string" },
    kind: { type: "string", enum: ["task", "question", "chat"] },
    reply: { type: "string" },
    todos: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 6 },
  },
  required: ["goal", "kind", "reply", "todos"],
};

export type MessageKind = "task" | "question" | "chat";

export interface Plan {
  /** chat: greeting/small talk, answered with `reply`; question: read-only answer; task: run the todos. */
  kind: MessageKind;
  reply: string;
  /** The task restated by the model; forces it to understand (and translate) the task before planning. */
  goal: string;
  todos: string[];
  /** The planner exchange; appended to history so later steps reuse its KV cache. */
  messages: ChatMessage[];
}

/** Words that make a message a request for changes, even when phrased as a question ("can you add ...?"). */
const REQUEST_WORDS =
  /\b(add|fix|create|make|implement|write|change|update|remove|delete|rename|refactor|move|generate|build|install|set ?up|can you|could you|please|must|should|needs? to|ensure|make sure)\b|qo'?sh|tuzat|yoz(ib|ing)?\b|yarat|o'?zgartir|o'?chir|almashtir|qil(ib|ing|a olasanmi)|iltimos|sozla|добав|исправ|создай|сделай|напиши|измени|удали/i;
/**
 * Question words. English ones count only at the start ("when"/"which" are common in
 * specs: "throw when the email is invalid"); Uzbek and Russian ones anywhere.
 */
const QUESTION_WORDS = /^\s*(how|what|why|where|which|when|explain)\b|\b(qanday|qanaqa|nima|nimaga|nega|qayerda|qaysi|qachon|nechta|tushuntir)\b|как|что|почему|где|зачем/i;

/**
 * Message kinds the planner may choose, decided without the model: small models
 * misread short or non-English messages (and "???" once re-ran a project generator).
 */
export function allowedKinds(text: string): MessageKind[] {
  const t = text.trim();
  if (!/[\p{L}\p{N}]/u.test(t)) return ["chat"]; // only punctuation/emoji: "???", "!!", "👍"
  if (REQUEST_WORDS.test(t)) return ["task", "question", "chat"];
  if (QUESTION_WORDS.test(t)) return ["question"]; // a real question gets a real (read-the-code) answer
  if (/\?\s*$/.test(t)) return ["question", "chat"]; // "qalaysan?" may just be small talk
  return ["task", "question", "chat"];
}

export async function makePlan(provider: LLMProvider, prefix: ChatMessage[], signal?: AbortSignal, message = ""): Promise<Plan> {
  const request: ChatMessage = { role: "user", content: PLAN_REQUEST };
  const kinds = message ? allowedKinds(message) : (["task", "question", "chat"] as MessageKind[]);
  const planSchema: Schema = { ...PLAN_SCHEMA, properties: { ...PLAN_SCHEMA.properties, kind: { type: "string", enum: kinds } } };
  // xml mode means the endpoint can't constrain output; parse the JSON leniently instead.
  const schema = provider.profile.toolMode === "xml" ? undefined : planSchema;
  const res = await provider.chat({ messages: mergeConsecutive([...prefix, request]), schema, signal, temperature: 0.1 });
  let todos: string[] = [];
  let goal = "";
  let kind: MessageKind = "task";
  let reply = "";
  try {
    const parsed = JSON.parse(/\{[\s\S]*\}/.exec(res.content)?.[0] ?? res.content);
    goal = String(parsed.goal ?? "");
    if (parsed.kind === "chat" || parsed.kind === "question" || parsed.kind === "task") kind = parsed.kind;
    reply = String(parsed.reply ?? "").trim();
    if (Array.isArray(parsed.todos)) todos = parsed.todos.map(String).map((t: string) => t.trim()).filter(Boolean);
  } catch {
    /* handled below */
  }
  if (!kinds.includes(kind)) kind = kinds[0]; // unconstrained endpoints (xml mode)
  if (kind === "chat" && !reply) kind = kinds.includes("question") ? "question" : "chat"; // nothing to show: answer it properly
  if (kind === "chat" && !reply) reply = "Could you say a bit more about what you'd like me to do?";
  if (kind === "task" && !todos.length) todos = [goal || "Complete the task"];
  todos = todos.slice(0, 6);
  return { kind, reply, goal, todos, messages: [request, { role: "assistant", content: JSON.stringify({ goal, kind, reply, todos }) }] };
}

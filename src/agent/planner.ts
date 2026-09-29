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
/** Asking to remember something ("Remember that ...", "from now on ..."): a task for the remember tool, not small talk. */
const REMEMBER =
  /^\s*(please\s+|pls\s+)?(remember|keep in mind|memori[sz]e|note that)\b|\b(can|could|would|will) you (please )?(remember|keep in mind)\b|\bfrom now on\b|eslab qol|esda tut|запомни|впредь/i;

export function allowedKinds(text: string): MessageKind[] {
  const t = text.trim();
  if (!/[\p{L}\p{N}]/u.test(t)) return ["chat"]; // only punctuation/emoji: "???", "!!", "👍"
  if (REMEMBER.test(t)) return ["task"]; // qwen3.5 answered "Understood, I will remember" and saved nothing
  if (REQUEST_WORDS.test(t)) return ["task", "question", "chat"];
  if (QUESTION_WORDS.test(t)) return ["question"]; // a real question gets a real (read-the-code) answer
  if (/\?\s*$/.test(t)) return ["question", "chat"]; // "qalaysan?" may just be small talk
  return ["task", "question", "chat"];
}

const FILE_NAME = /[\w./-]*[\w-]\.(?:tsx?|jsx?|mjs|cjs|py|cs|fs|go|java|kt|rs|rb|php|cpp|cc|c|hpp|h|swift|json|ya?ml|toml|md|html|css|scss|sql|csproj|sln)\b/gi;

/** The files a todo names, e.g. ["src/tax.js"]. */
export function namedFiles(todo: string): string[] {
  return [...new Set(todo.match(FILE_NAME) ?? [])];
}

const CODE_IN_TODOS =
  "Your todos contain lines of code. Each todo must be one sentence that describes a change and names its file; the code is written later, not in the plan. Reply with the plan JSON again.";

function parsePlan(content: string): { goal: string; kind: MessageKind; reply: string; todos: string[] } {
  const plan = { goal: "", kind: "task" as MessageKind, reply: "", todos: [] as string[] };
  try {
    const parsed = JSON.parse(/\{[\s\S]*\}/.exec(content)?.[0] ?? content);
    plan.goal = String(parsed.goal ?? "");
    if (parsed.kind === "chat" || parsed.kind === "question" || parsed.kind === "task") plan.kind = parsed.kind;
    plan.reply = String(parsed.reply ?? "").trim();
    if (Array.isArray(parsed.todos)) plan.todos = parsed.todos.map(String).map((t: string) => t.trim()).filter(Boolean);
  } catch {
    /* not JSON: an empty task plan, completed by the caller */
  }
  return plan;
}

/**
 * Planners sometimes put code into the todo list, one line per todo ("Create IClock.cs with:",
 * "```csharp", "{", "}"). Fenced blocks and lone brackets go back into the todo before them.
 */
function foldCode(todos: string[]): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const t of todos) {
    const fence = /^\s*```/.test(t);
    if (out.length && (fenced || fence || /^[\s{}()[\];,]+$/.test(t))) out[out.length - 1] += `\n${t}`;
    else out.push(t);
    if (fence) fenced = !fenced;
  }
  return out;
}

const LOOK_ONLY = /^(read|review|identify|locate|find|understand|analy[sz]e|inspect|examine|investigate|look\s+(at|into|for)|search|open|explore|study)\b/i;
/** A change verb (not the noun: "identify the change that broke it"). */
const CHANGES = /(?<!\b(the|a|an|this|that|my|your|each|every|specific)\s+)\b(fix|change|update|add|remove|implement|replace|rename|move|create|write|edit|make|set|refactor|convert|delete|extract|use|return|handle)\b/i;

/**
 * Todos that only look ("Read the changes with git diff", "Identify the change that broke
 * the tests", "Locate the test") are dropped: reading happens inside the todo that changes
 * something, and a separate looking todo makes small models redo (or undo) earlier work.
 */
export function dropLookOnlyTodos(todos: string[], goal: string): string[] {
  const kept = todos.filter((t) => !LOOK_ONLY.test(t.trim()) || CHANGES.test(t));
  return kept.length ? kept : [goal || todos[0]];
}

const TEST_TODO = /^(test|verify|validate|check|ensure)\b|\b(write|add|create)\s+(a\s+|some\s+|the\s+)?(unit\s+)?tests?\b|\bunit tests?\b/i;
const ASKS_FOR_CHECKS = /\b(tests?|specs?|verify|check|curl|validate)\b/i;

/**
 * Test and verification todos the user didn't ask for ("Test equality with unit tests"):
 * project checks run by themselves, and a 7B model adds an xUnit file to a console project
 * and breaks its build. Kept when the message mentions tests or checking.
 */
export function dropUnaskedTestTodos(todos: string[], message: string): string[] {
  if (ASKS_FOR_CHECKS.test(message)) return todos;
  const kept = todos.filter((t) => !TEST_TODO.test(t.trim()));
  return kept.length ? kept : todos;
}

const sameFile = (a: string, b: string) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);

/**
 * Consecutive todos about the same single file become one. Planners split "create
 * src/tax.js", "add computeTax to src/tax.js", "export it from src/tax.js" into three;
 * a small model then creates an empty file, or does everything in the first todo and
 * runs out of its steps.
 */
export function mergeTodos(todos: string[]): string[] {
  const out: string[] = [];
  for (const t of foldCode(todos)) {
    const prev = out[out.length - 1];
    const a = prev === undefined ? [] : namedFiles(prev);
    const b = namedFiles(t);
    // "Add ..." → "add ..." after "then"; a leading name ("TextUtils.cs: ...") keeps its case.
    const next = /^[A-Z][a-z]+\s/.test(t) ? t[0].toLowerCase() + t.slice(1) : t;
    if (a.length === 1 && b.length === 1 && sameFile(a[0], b[0])) out[out.length - 1] = `${prev.replace(/[.\s]+$/, "")}; then ${next}`;
    else out.push(t);
  }
  return out;
}

export async function makePlan(provider: LLMProvider, prefix: ChatMessage[], signal?: AbortSignal, message = ""): Promise<Plan> {
  const request: ChatMessage = { role: "user", content: PLAN_REQUEST };
  const kinds = message ? allowedKinds(message) : (["task", "question", "chat"] as MessageKind[]);
  const planSchema: Schema = { ...PLAN_SCHEMA, properties: { ...PLAN_SCHEMA.properties, kind: { type: "string", enum: kinds } } };
  // xml mode means the endpoint can't constrain output; parse the JSON leniently instead.
  const schema = provider.profile.toolMode === "xml" ? undefined : planSchema;
  const ask = (messages: ChatMessage[]) => provider.chat({ messages: mergeConsecutive(messages), schema, signal, temperature: 0.1 });
  let res = await ask([...prefix, request]);
  let { goal, kind, reply, todos } = parsePlan(res.content);
  // Code lines as todos crowd out the real steps (6 at most): ask once more for sentences.
  if (kind === "task" && foldCode(todos).length < todos.length) {
    res = await ask([...prefix, request, { role: "assistant", content: res.content }, { role: "user", content: CODE_IN_TODOS }]);
    ({ goal, kind, reply, todos } = parsePlan(res.content));
  }
  if (!kinds.includes(kind)) kind = kinds[0]; // unconstrained endpoints (xml mode)
  if (kind === "chat" && !reply) kind = kinds.includes("question") ? "question" : "chat"; // nothing to show: answer it properly
  if (kind === "chat" && !reply) reply = "Could you say a bit more about what you'd like me to do?";
  if (kind === "task" && !todos.length) todos = [goal || "Complete the task"];
  todos = kind === "task" ? dropUnaskedTestTodos(dropLookOnlyTodos(mergeTodos(todos), goal), message).slice(0, 6) : todos;
  return { kind, reply, goal, todos, messages: [request, { role: "assistant", content: JSON.stringify({ goal, kind, reply, todos }) }] };
}

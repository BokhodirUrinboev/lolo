import type { AgentMode } from "../tools/registry";
import { uzbekHints } from "./glossary";

/**
 * Prompt pieces. Order matters for KV-cache reuse: everything in the system
 * message is identical across all steps of a run (and across runs until rules or
 * the repo map change); only the tail of the conversation grows.
 */
const REPLY_FORMAT = {
  schema: 'Reply with JSON only: {"thought": "<short reasoning>", "action": {"tool": "<name>", "args": {...}}}',
  native: "Reply by calling exactly one tool. Put your short reasoning in the message text.",
  xml: 'Reply in exactly this format:\n<thought>short reasoning</thought>\n<tool name="TOOL_NAME">{"arg": "value"}</tool>',
};

export function systemPrompt(opts: {
  mode: AgentMode;
  model?: string;
  toolMode?: keyof typeof REPLY_FORMAT;
  toolList: string;
  rules: string;
  verifyCommands: string[];
  repoMap: string;
  environment?: string;
  /** "server: tool1, tool2" lines for connected MCP servers. */
  mcp?: string;
  /** Facts from .agent/memory.md. */
  memory?: string;
}): string {
  const modeRules =
    opts.mode === "ask"
      ? "- You may only read and search. When you know enough, call answer with the complete explanation."
      : "- Read a file before editing it. Never guess file contents.\n" +
        "- Each read_file result says which edit tool works best for that file; prefer it.\n" +
        "- rewrite_file: write the whole file, every line, no placeholders. edit: copy `search` exactly from the latest read_file output.\n" +
        (opts.verifyCommands.length
          ? `- Project checks (${opts.verifyCommands.map((c) => "`" + c + "`").join(", ")}) run automatically when you call done; if they fail you get the errors. Do not guess other build or test commands.`
          : "- Project checks (build/type check) run automatically when you call done; if they fail you get the errors.") +
        "\n- Use the installed versions listed under Environment. Never downgrade frameworks or packages, and don't edit project files " +
        "(.csproj, package.json, ...) unless the task needs it.\n" +
        "- Never start servers or watchers (dotnet run, npm start, npm run dev): they never finish.";
  const sections = [
    `You are Agent Lolo, a coding agent running locally${opts.model ? ` on the ${opts.model} model` : ""} in the user's VS Code. You are not Claude, ChatGPT or any other assistant. ` +
      `You work in the user's repository and act by calling exactly one tool per reply.
${REPLY_FORMAT[opts.toolMode ?? "schema"]}

Tools:
${opts.toolList}

Rules:
- Work on the current todo item only. When it is complete, call done with a short summary. For questions, call answer instead.
${modeRules}
- Paths are relative to the workspace root.
- If a tool fails, read the error and fix the cause. Never repeat the same call.
- Keep thoughts short. Write summaries in the same language as the user's task.`,
  ];
  if (opts.environment) sections.push(`Environment: ${opts.environment}`);
  if (opts.mcp) {
    sections.push(
      `External tools (MCP servers). They are offered in the steps where a todo is about them; plan todos that use them (e.g. "Save the note with the notes server") instead of editing files:\n${opts.mcp}`,
    );
  }
  if (opts.rules) sections.push(`Project rules (.agent/rules.md):\n${opts.rules}`);
  if (opts.memory) sections.push(`Remembered from earlier conversations (.agent/memory.md):\n${opts.memory}`);
  if (opts.repoMap) sections.push(`Repository map (files and their main symbols):\n${opts.repoMap}`);
  return sections.join("\n\n");
}

/** Per-run user message: earlier conversation (so follow-ups like "do it" make sense), editor context, then the new message. */
export function taskMessage(task: string, context: string, conversation = ""): string {
  const parts = [];
  if (conversation) parts.push(`Earlier in this conversation (oldest first):\n${conversation}`);
  if (context) parts.push(context);
  const hints = uzbekHints(task);
  parts.push(`${conversation ? "New message" : "Task"}: ${task}${hints ? `\n${hints}` : ""}`);
  return parts.join("\n\n");
}

export const PLAN_REQUEST =
  'First understand the new message, then plan. Reply with JSON {"goal": "...", "kind": "...", "reply": "...", "todos": [...]}. ' +
  "`goal`: the new message restated precisely in English, resolved against the earlier conversation (what is wanted, and where). " +
  '`kind`: "task" when the user wants code changed or created; "question" when they want an explanation or information ' +
  "(how something works, how to run it, why) and no changes; \"chat\" for greetings, thanks or small talk, or when the message is too unclear to act on. " +
  "`reply`: only for chat: a short reply in the user's language (for an unclear message, one clarifying question); otherwise empty. " +
  '"do it", "start", "continue" or "yes" after a proposed plan means kind "task" with that plan\'s steps as todos. ' +
  "`todos`: only for a task: each todo is one concrete change, naming the file or symbol when known, " +
  'e.g. "Return null from findUser() in src/users.ts when the id is empty". Use as few todos as possible: a single fix is 1 todo, most tasks need 1-3, never more than 6. Renaming a symbol everywhere is 1 todo, not one per file; creating a file is 1 todo together with its content. If the user only asks you to remember something, the one todo is to remember it, with no code changes. ' +
  "Do not add todos for reading, finding, checking or testing: you do that inside each todo, and project checks run automatically. " +
  "Do exactly what was asked with the simplest working solution: no extras (databases, auth, validation, logging, refactors) the user did not ask for. " +
  "To start a new project, use the platform's generator in the first todo (e.g. dotnet new, npm create).";

export const QUESTION_NOTE =
  "This is a question, not a change request. Do not change anything. Read what you need, then call answer with a complete explanation in the user's language.";

export function todoPrompt(index: number, todos: string[]): string {
  return `Todo ${index + 1}/${todos.length}: ${todos[index]}`;
}

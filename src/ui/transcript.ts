import type { AgentEvent } from "../agent/loop";
import type { Item, Turn } from "./protocol";

/** Transcript logic shared by the chat panel and the CLI REPL (no vscode imports). */

const MAX_TOOL_OUTPUT = 4000;
const CONVERSATION_TURNS = 6;
const CONVERSATION_CHARS = 6000;

/**
 * Earlier turns as plain text for the next run, newest kept first when trimming,
 * so follow-ups ("do it", "now add tests", "why?") have their context.
 */
export function conversationText(turns: Turn[]): string {
  const blocks: string[] = [];
  let used = 0;
  for (const t of [...turns].reverse().slice(0, CONVERSATION_TURNS)) {
    const lines: string[] = [];
    for (const i of t.items) {
      if (i.kind === "user") lines.push(`User: ${i.text}`);
      else if (i.kind === "plan") lines.push(`Assistant plan:\n${i.todos.map((x, n) => `  ${n + 1}. ${x}`).join("\n")}`);
      else if (i.kind === "question" && i.answer) lines.push(`Assistant asked: ${i.text}\nUser answered: ${i.answer}`);
      else if (i.kind === "approval" && i.state === "no") lines.push(`User rejected ${i.action} ${i.target}${i.feedback ? `: ${i.feedback}` : ""}`);
      else if (i.kind === "result") {
        const summary = i.summary.length > 800 ? i.summary.slice(0, 800) + "…" : i.summary;
        if (i.status === "planned") lines.push("Assistant: (plan proposed above, not executed yet)");
        else if (i.status === "cancelled") lines.push("Assistant: (stopped by the user before finishing)");
        else lines.push(`Assistant${i.status === "failed" ? " (did not finish)" : ""}: ${summary}${i.changed.length ? `\n  changed files: ${i.changed.join(", ")}` : ""}`);
      }
    }
    const block = lines.join("\n");
    if (used + block.length > CONVERSATION_CHARS && blocks.length) break;
    blocks.unshift(block);
    used += block.length;
  }
  return blocks.join("\n\n");
}


/** Folds an agent event into the turn's items (streaming/token events are the caller's business). */
export function applyEvent(turn: Turn, e: AgentEvent) {
  const items = turn.items;
  const plan = items.find((i): i is Extract<Item, { kind: "plan" }> => i.kind === "plan");
  switch (e.type) {
    case "status": {
      const s = items.find((i) => i.kind === "status");
      if (s && s.kind === "status") s.text = e.text;
      else items.push({ kind: "status", text: e.text });
      return;
    }
    case "plan":
      if (plan) {
        plan.todos = e.todos;
        plan.goal = e.goal ?? plan.goal;
        plan.states = e.todos.map(() => "pending");
      } else items.push({ kind: "plan", goal: e.goal, todos: e.todos, states: e.todos.map(() => "pending") });
      return;
    case "todo":
      if (plan) plan.states[e.index] = e.status;
      return;
    case "thought":
      items.push({ kind: "thought", text: e.text });
      return;
    case "tool":
      items.push({
        kind: "tool",
        tool: e.tool,
        target: toolTarget(e.args),
        title: e.result.summary,
        ok: e.result.ok,
        output: e.result.output.slice(0, MAX_TOOL_OUTPUT),
      });
      return;
    case "invalid":
      items.push({ kind: "invalid", text: e.error });
      return;
    case "verify":
      items.push({ kind: "verify", ok: e.ok, output: e.output.slice(0, MAX_TOOL_OUTPUT) });
      return;
    case "error":
      items.push({ kind: "error", text: e.message });
      return;
    case "done": {
      const r = e.result;
      const s = r.stats;
      items.push({
        kind: "result",
        status: r.status,
        summary: r.status === "planned" ? "Plan ready. Edit it by replying, or run it as is." : r.summary,
        changed: r.changed,
        checkpoint: r.checkpoint,
        stats: [
          s.steps ? `${s.steps} steps` : "",
          s.toolCalls ? `${s.toolCalls} tool calls${s.invalidCalls ? ` (${s.invalidCalls} invalid)` : ""}` : "",
          s.editCalls ? `${s.editsApplied}/${s.editCalls} edits` : "",
          `${(s.ms / 1000).toFixed(1)}s`,
        ]
          .filter(Boolean)
          .join(" · "),
      });
      return;
    }
  }
}

/** Short "go ahead" replies in the languages users of this extension write in. */
const GO_AHEAD =
  /^(ha+|xa+|ha mayli|mayli|xo'?p|xop|ok(ay)?|yes|yep|yeah|sure|go( ahead)?|do it|start|run( it)?|proceed|continue|let'?s go|boshla(ng)?|ishni boshla(ng)?|boshlay(ver|mi[zs]?)|davom( et(ing)?)?|bajar(ing)?|qil(ing)?|to'?g'?ri|да(вай)?|начинай|делай|поехали|вперёд)(?=$|[\s.,!?;:])/iu;

/**
 * If the previous turn proposed a plan that hasn't run and the new message is a
 * short go-ahead, returns that plan. Deterministic on purpose: small models often
 * misread "ishni boshla" as small talk.
 */
export function pendingPlanFor(turns: Turn[], text: string): { goal?: string; todos: string[] } | undefined {
  const last = turns[turns.length - 1];
  const result = last?.items.find((i) => i.kind === "result");
  const plan = last?.items.find((i) => i.kind === "plan");
  if (result?.kind !== "result" || result.status !== "planned" || plan?.kind !== "plan") return undefined;
  const words = text.trim().replace(/[.!?,;:]+$/g, "").split(/\s+/);
  if (words.length > 6 || !GO_AHEAD.test(text.trim())) return undefined;
  return { goal: plan.goal, todos: plan.todos };
}

function toolTarget(args: Record<string, unknown>): string | undefined {
  if (typeof args.symbol === "string") return args.new_name ? `${args.symbol} → ${args.new_name}` : (args.symbol as string);
  if (typeof args.from === "string" && typeof args.to === "string") return `${args.from} → ${args.to}`;
  for (const k of ["path", "command", "query", "url"]) if (typeof args[k] === "string") return args[k] as string;
  return undefined;
}

/** Conversation title: the first user message, shortened. */
export function titleOf(turns: Turn[]): string {
  const first = turns[0]?.items.find((i) => i.kind === "user");
  if (first?.kind !== "user") return "";
  const t = first.text.replace(/\s+/g, " ").trim();
  return t.length > 48 ? t.slice(0, 47) + "…" : t;
}

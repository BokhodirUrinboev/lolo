import { useEffect, useRef, useState } from "react";
import type { Item, Mode, ToWebview, Turn, ViewState } from "../protocol";
import { Markdown } from "./Markdown";
import { post, uiState } from "./vscode";

const TOOL_ICON: Record<string, string> = {
  read_file: "📄", search: "🔍", list_dir: "📁", get_diagnostics: "🩺",
  edit: "✏️", rewrite_file: "✏️", edit_lines: "✏️", create_file: "🆕",
  run_command: "▶", ask_user: "❓",
};
const TODO_ICON = { pending: "○", active: "◐", done: "✔", failed: "✘" } as const;
const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: "ask", label: "Ask", hint: "Read-only: answers questions about the code" },
  { id: "agent", label: "Agent", hint: "Plans, edits files and runs checks" },
  { id: "plan", label: "Plan", hint: "Only makes a plan" },
];

export function App() {
  const [state, setState] = useState<ViewState>();
  const [streaming, setStreaming] = useState<{ thought: string; answer?: string }>();
  const [review, setReview] = useState<{ todos: string[]; goal?: string }>();
  const [mentions, setMentions] = useState<{ label: string; detail?: string }[]>([]);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMessage = (e: MessageEvent<ToWebview>) => {
      const m = e.data;
      if (m.type === "state") {
        setState(m.state);
        setStreaming(undefined);
        if (!m.state.running) setReview(undefined);
      } else if (m.type === "streaming") setStreaming({ thought: m.thought, answer: m.answer });
      else if (m.type === "planReview") setReview({ todos: m.todos, goal: m.goal });
      else if (m.type === "mentionResults") setMentions(m.items);
    };
    window.addEventListener("message", onMessage);
    post({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => bottom.current?.scrollIntoView({ block: "end" }), [state, streaming, review]);

  if (!state) return <div className="empty">Loading…</div>;
  return (
    <div className="app">
      <Header state={state} />
      <div className="transcript">
        {!state.turns.length && (
          <div className="empty">
            <p>Local coding agent running on <b>{state.model}</b>.</p>
            <p>Type <code>@</code> to attach files, <code>@problems</code>, <code>@git</code>, <code>@terminal</code> or <code>@symbol:Name</code>.</p>
          </div>
        )}
        {state.turns.map((t) => (
          <TurnView key={t.id} turn={t} streaming={t.running ? streaming : undefined} />
        ))}
        {review && <PlanReview review={review} onDone={() => setReview(undefined)} />}
        <div ref={bottom} />
      </div>
      <Composer state={state} mentions={mentions} clearMentions={() => setMentions([])} />
    </div>
  );
}

function Header({ state }: { state: ViewState }) {
  const models = state.models.includes(state.model) ? state.models : [state.model, ...state.models];
  return (
    <div className="header">
      <select value={state.model} title="Model" disabled={state.running} onChange={(e) => post({ type: "setModel", model: e.target.value })}>
        {models.map((m) => (
          <option key={m}>{m}</option>
        ))}
      </select>
      <button className="icon" title="New chat" disabled={state.running} onClick={() => post({ type: "newChat" })}>
        ＋
      </button>
    </div>
  );
}

function TurnView({ turn, streaming }: { turn: Turn; streaming?: { thought: string; answer?: string } }) {
  const status = turn.items.find((i) => i.kind === "status");
  return (
    <div className="turn">
      {turn.items.map((item, i) => (
        <ItemView key={i} item={item} turnId={turn.id} running={turn.running} />
      ))}
      {turn.running && (
        <div className="live">
          <span className="spinner" />
          {streaming?.answer ? <Markdown text={streaming.answer} /> : <span className="thought">{streaming?.thought || (status?.kind === "status" ? status.text : "Thinking")}…</span>}
        </div>
      )}
    </div>
  );
}

function ItemView({ item, turnId, running }: { item: Item; turnId: string; running: boolean }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="user">
          <span className="badge">{item.mode}</span>
          {item.text}
        </div>
      );
    case "status":
      return null;
    case "plan":
      return (
        <div className="card plan">
          {item.goal && <div className="goal">{item.goal}</div>}
          <ol>
            {item.todos.map((t, i) => (
              <li key={i} className={item.states[i]}>
                <span className="todo-icon">{TODO_ICON[item.states[i]]}</span> {t}
              </li>
            ))}
          </ol>
        </div>
      );
    case "thought":
      return <div className="thought">{item.text}</div>;
    case "tool":
      return (
        <details className={`card tool ${item.ok ? "" : "failed"}`}>
          <summary>
            <span className="tool-icon">{TOOL_ICON[item.tool] ?? "•"}</span> {item.title}
          </summary>
          <pre>{item.output}</pre>
        </details>
      );
    case "invalid":
      return <div className="invalid">⚠ {item.text}</div>;
    case "verify":
      return (
        <details className={`card tool ${item.ok ? "" : "failed"}`} open={!item.ok}>
          <summary>{item.ok ? "✔ checks passed" : "✘ checks failed"}</summary>
          <pre>{item.output}</pre>
        </details>
      );
    case "error":
      return <div className="error">{item.text}</div>;
    case "question":
      return <QuestionCard item={item} />;
    case "approval":
      return <ApprovalCard item={item} live={running} />;
    case "result":
      return (
        <div className={`card result ${item.status}`}>
          <Markdown text={item.summary} />
          {item.changed.length > 0 && (
            <div className="changed">
              {item.changed.map((f) => (
                <a key={f} onClick={() => post({ type: "openFile", path: f })}>
                  {f}
                </a>
              ))}
            </div>
          )}
          <div className="stats">
            <span>
              {item.status === "done" ? "" : `${item.status} · `}
              {item.stats}
            </span>
            {item.status === "planned" && (
              <button title="Execute these steps in Agent mode" onClick={() => post({ type: "runPlan", turnId })}>
                ▶ Run this plan
              </button>
            )}
            {item.checkpoint && item.changed.length > 0 && (
              <button className="link" title="Restore all files to before this run" onClick={() => post({ type: "restore", checkpoint: item.checkpoint! })}>
                ↺ Restore
              </button>
            )}
          </div>
        </div>
      );
  }
}

const ACTION_TITLE = { edit: "Edit", create: "Create", command: "Run command" } as const;

function ApprovalCard({ item, live }: { item: Extract<Item, { kind: "approval" }>; live: boolean }) {
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const decide = (decision: "yes" | "always" | "no", fb?: string) => post({ type: "approval", id: item.id, decision, feedback: fb });
  const pending = item.state === "pending" && live;
  const always = item.action === "command" ? `Yes, don't ask again for \`${item.target.trim().split(/\s+/).slice(0, 2).join(" ")}\`` : "Yes, allow all edits this session";
  const onKey = (e: React.KeyboardEvent) => {
    if (!pending || rejecting || (e.target as HTMLElement).tagName === "INPUT") return;
    if (e.key === "1") decide("yes");
    else if (e.key === "2") decide("always");
    else if (e.key === "3") setRejecting(true);
  };
  return (
    <div className={`card approval ${item.state}`} tabIndex={-1} onKeyDown={onKey}>
      <div className="approval-head">
        <span className="approval-title">
          {ACTION_TITLE[item.action]} {item.action !== "command" && <code>{item.target}</code>}
        </span>
        {item.action !== "command" && pending && (
          <button className="link" onClick={() => post({ type: "openDiff", id: item.id })}>
            Open diff
          </button>
        )}
      </div>
      {item.action === "command" ? (
        <>
          <pre className="cmd">$ {item.target}</pre>
          {pending && <div className="thought">{item.detail}</div>}
        </>
      ) : (
        <DiffView diff={item.detail} collapsed={!pending} />
      )}
      {pending && !rejecting && (
        <div className="approval-actions">
          <button autoFocus onClick={() => decide("yes")}>
            1 · Yes
          </button>
          <button className="secondary" onClick={() => decide("always")}>
            2 · {always}
          </button>
          <button className="secondary" onClick={() => setRejecting(true)}>
            3 · No
          </button>
        </div>
      )}
      {pending && rejecting && (
        <div className="review-row">
          <input
            autoFocus
            value={feedback}
            placeholder="Tell the agent what to do instead (optional), Enter to send"
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && decide("no", feedback)}
          />
          <button onClick={() => decide("no", feedback)}>No</button>
        </div>
      )}
      {!pending && (
        <div className={`approval-state ${item.state === "no" ? "no" : "yes"}`}>
          {item.state === "pending" ? "— not decided (run ended)" : item.state === "no" ? `✘ Rejected${item.feedback ? `: ${item.feedback}` : ""}` : item.state === "always" ? "✔ Approved (won't ask again this session)" : "✔ Approved"}
        </div>
      )}
    </div>
  );
}

function DiffView({ diff, collapsed }: { diff: string; collapsed: boolean }) {
  const lines = diff.split("\n");
  const added = lines.filter((l) => l.startsWith("+")).length;
  const removed = lines.filter((l) => l.startsWith("-")).length;
  const body = (
    <pre className="diff">
      {lines.map((l, i) => (
        <div key={i} className={l.startsWith("@@") ? "hunk" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : ""}>
          {l || " "}
        </div>
      ))}
    </pre>
  );
  if (!collapsed) return body;
  return (
    <details>
      <summary className="thought">
        +{added} −{removed} lines
      </summary>
      {body}
    </details>
  );
}

function QuestionCard({ item }: { item: Extract<Item, { kind: "question" }> }) {
  const [text, setText] = useState("");
  const answered = item.answer !== undefined;
  const send = (value: string | null) => post({ type: "answer", text: value });
  return (
    <div className="card review">
      <div className="review-title">❓ {item.text}</div>
      {answered ? (
        <div className={item.answer ? "" : "thought"}>{item.answer ?? "(skipped)"}</div>
      ) : (
        <>
          <div className="review-row">
            <input autoFocus value={text} placeholder="Your answer" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && text.trim() && send(text)} />
          </div>
          <div className="review-actions">
            <span />
            <button className="secondary" onClick={() => send(null)}>
              Skip
            </button>
            <button disabled={!text.trim()} onClick={() => send(text)}>
              Answer
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function PlanReview({ review, onDone }: { review: { todos: string[]; goal?: string }; onDone: () => void }) {
  const [todos, setTodos] = useState(review.todos);
  const update = (i: number, v: string) => setTodos(todos.map((t, j) => (j === i ? v : t)));
  const decide = (run: boolean) => {
    post({ type: "planDecision", todos: run ? todos.map((t) => t.trim()).filter(Boolean) : null });
    onDone();
  };
  return (
    <div className="card review">
      <div className="review-title">Review the plan</div>
      {review.goal && <div className="goal">{review.goal}</div>}
      {todos.map((t, i) => (
        <div className="review-row" key={i}>
          <span>{i + 1}.</span>
          <input value={t} onChange={(e) => update(i, e.target.value)} />
          <button className="icon" title="Remove" onClick={() => setTodos(todos.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <div className="review-actions">
        <button className="link" onClick={() => setTodos([...todos, ""])} disabled={todos.length >= 6}>
          ＋ Add step
        </button>
        <span />
        <button className="secondary" onClick={() => decide(false)}>
          Cancel
        </button>
        <button onClick={() => decide(true)} disabled={!todos.some((t) => t.trim())}>
          Run
        </button>
      </div>
    </div>
  );
}

function Composer({ state, mentions, clearMentions }: { state: ViewState; mentions: { label: string; detail?: string }[]; clearMentions: () => void }) {
  const [text, setText] = useState(() => uiState.get("draft", ""));
  const [mode, setMode] = useState<Mode>(state.mode);
  const [query, setQuery] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => setMode(state.mode), [state.mode]);
  useEffect(() => uiState.set("draft", text), [text]);

  const onChange = (v: string) => {
    setText(v);
    const caret = area.current?.selectionStart ?? v.length;
    const m = /(?:^|\s)@([\w./:-]*)$/.exec(v.slice(0, caret));
    if (m) {
      setQuery(m[1]);
      setSel(0);
      post({ type: "mentionQuery", query: m[1] });
    } else {
      setQuery(null);
      clearMentions();
    }
  };

  const pick = (label: string) => {
    const caret = area.current?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/@([\w./:-]*)$/, `@${label}${label.endsWith(":") ? "" : " "}`);
    setText(before + text.slice(caret));
    setQuery(null);
    clearMentions();
    area.current?.focus();
  };

  const send = () => {
    if (!text.trim() || state.running) return;
    post({ type: "send", text: text.trim(), mode });
    setText("");
  };

  const onKey = (e: React.KeyboardEvent) => {
    const open = query !== null && mentions.length > 0;
    if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setSel((s) => (s + (e.key === "ArrowDown" ? 1 : mentions.length - 1)) % mentions.length);
    } else if (open && (e.key === "Enter" || e.key === "Tab")) {
      e.preventDefault();
      pick(mentions[sel].label);
    } else if (open && e.key === "Escape") {
      setQuery(null);
      clearMentions();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const ctx = state.context;
  const pct = ctx ? Math.min(100, Math.round((ctx.used / ctx.total) * 100)) : 0;
  return (
    <div className="composer">
      {query !== null && mentions.length > 0 && (
        <div className="mentions">
          {mentions.map((m, i) => (
            <div key={m.label} className={i === sel ? "sel" : ""} onMouseDown={(e) => (e.preventDefault(), pick(m.label))}>
              @{m.label} {m.detail && <span className="detail">{m.detail}</span>}
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={area}
        rows={3}
        value={text}
        placeholder={mode === "ask" ? "Ask about the code…" : "Describe the task…  (@ to mention)"}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKey}
      />
      <div className="composer-bar">
        <div className="modes">
          {MODES.map((m) => (
            <button key={m.id} title={m.hint} className={m.id === mode ? "on" : ""} disabled={state.running} onClick={() => (setMode(m.id), post({ type: "setMode", mode: m.id }))}>
              {m.label}
            </button>
          ))}
        </div>
        <button
          className={`toggle ${state.autoAccept ? "on" : ""}`}
          title="Apply the agent's edits without asking (this chat session only). A checkpoint is still taken before every run."
          onClick={() => post({ type: "setAutoAccept", on: !state.autoAccept })}
        >
          {state.autoAccept ? "✔ " : ""}Auto-accept edits
        </button>
        {ctx && (
          <div className="ctx" title={`Last step used ${ctx.used} of ${ctx.total} context tokens`}>
            <div style={{ width: `${pct}%` }} />
          </div>
        )}
        {state.running ? (
          <button className="stop" onClick={() => post({ type: "cancel" })}>
            Stop
          </button>
        ) : (
          <button onClick={send} disabled={!text.trim()}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}

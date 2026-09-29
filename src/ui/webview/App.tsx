import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Item, Mode, SessionInfo, ToWebview, Turn, ViewState } from "../protocol";
import { Markdown } from "./Markdown";
import { post, uiState } from "./vscode";

// ---------------------------------------------------------------------------
// Modes as the user sees them (Claude Code style): permission level + plan/read-only.

type UiMode = "agent" | "auto" | "full" | "plan" | "ask";
const UI_MODES: { id: UiMode; label: string; icon: string; hint: string }[] = [
  { id: "agent", label: "Ask before edits", icon: "shield", hint: "Plans and edits; asks before every file change and new command" },
  { id: "auto", label: "Edit automatically", icon: "zap", hint: "Applies edits without asking; still asks before new commands" },
  { id: "full", label: "Run everything", icon: "rocket", hint: "Edits and terminal commands without asking; dangerous commands stay blocked, a checkpoint is taken" },
  { id: "plan", label: "Plan mode", icon: "checklist", hint: "Only proposes a plan; nothing is changed" },
  { id: "ask", label: "Read-only", icon: "eye", hint: "Answers questions about the code; never edits" },
];
const uiModeOf = (s: ViewState): UiMode => (s.mode === "agent" ? (s.autoRun ? "full" : s.autoAccept ? "auto" : "agent") : s.mode);
function setUiMode(m: UiMode) {
  post({ type: "setMode", mode: m === "auto" || m === "full" ? "agent" : (m as Mode) });
  post({ type: "setAutoAccept", on: m === "auto" || m === "full" });
  post({ type: "setAutoRun", on: m === "full" });
}

const TOOL_VERB: Record<string, string> = {
  read_file: "Read",
  search: "Search",
  list_dir: "List",
  get_diagnostics: "Diagnostics",
  edit: "Update",
  edit_lines: "Update",
  rewrite_file: "Write",
  create_file: "Create",
  run_command: "Bash",
  ask_user: "Ask",
  read_symbol: "Read",
  semantic_search: "Search",
  find_definition: "Definition",
  find_references: "References",
  rename_symbol: "Rename",
  move_file: "Move",
  delete_file: "Delete",
  git_diff: "Git diff",
  git_log: "Git log",
  git_blame: "Git blame",
  start_process: "Start",
  process_logs: "Logs",
  web_search: "Web search",
  fetch_url: "Fetch",
};

/** "mcp__notes__list_notes" → "notes · list_notes". */
function mcpLabel(tool: string): string {
  const [prefix, server, ...rest] = tool.split("__");
  return prefix === "mcp" && server && rest.length ? `${server} · ${rest.join("__")}` : tool;
}

const SLASH: { cmd: string; hint: string; run: () => void }[] = [
  { cmd: "/new", hint: "Start a new conversation", run: () => post({ type: "newChat" }) },
  { cmd: "/plan", hint: "Switch to plan mode", run: () => setUiMode("plan") },
  { cmd: "/agent", hint: "Ask before edits", run: () => setUiMode("agent") },
  { cmd: "/auto", hint: "Edit automatically", run: () => setUiMode("auto") },
  { cmd: "/yolo", hint: "Run everything: edits and commands without asking", run: () => setUiMode("full") },
  { cmd: "/ask", hint: "Read-only questions", run: () => setUiMode("ask") },
  { cmd: "/restore", hint: "Restore a checkpoint", run: () => post({ type: "command", id: "restoreCheckpoint" }) },
  { cmd: "/edit", hint: "Edit the selection in the editor (Ctrl+I)", run: () => post({ type: "command", id: "inlineEdit" }) },
  { cmd: "/settings", hint: "Open Agent Lolo settings", run: () => post({ type: "command", id: "openSettings" }) },
  { cmd: "/mcp", hint: "Show MCP server status", run: () => post({ type: "mcpStatus" }) },
  { cmd: "/memory", hint: "Edit what Agent Lolo remembers (.agent/memory.md)", run: () => post({ type: "command", id: "openMemory" }) },
];

const Icon = ({ name, spin }: { name: string; spin?: boolean }) => <i className={`codicon codicon-${name}${spin ? " codicon-modifier-spin" : ""}`} />;

// ---------------------------------------------------------------------------

export function App() {
  const [state, setState] = useState<ViewState>();
  const [streaming, setStreaming] = useState<{ thought: string; answer?: string }>();
  const [review, setReview] = useState<{ todos: string[]; goal?: string }>();
  const [mentions, setMentions] = useState<{ label: string; detail?: string }[]>([]);
  const [userCommands, setUserCommands] = useState<{ cmd: string; hint: string }[]>([]);
  const [insert, setInsert] = useState<{ text: string; n: number }>();
  const [showHistory, setShowHistory] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

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
      else if (m.type === "slashResults") setUserCommands(m.items);
      else if (m.type === "insertText") setInsert((p) => ({ text: m.text, n: (p?.n ?? 0) + 1 }));
    };
    window.addEventListener("message", onMessage);
    post({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Follow the conversation unless the user scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [state, streaming, review]);
  const onScroll = () => {
    const el = scroller.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  if (!state) return <div className="loading">Loading…</div>;
  return (
    <div className="app">
      <Header state={state} showHistory={showHistory} toggleHistory={() => setShowHistory(!showHistory)} />
      {showHistory ? (
        <History sessions={state.sessions} current={state.sessionId} close={() => setShowHistory(false)} />
      ) : (
        <div className="transcript" ref={scroller} onScroll={onScroll}>
          {!state.turns.length && <Welcome state={state} />}
          {state.turns.map((t) => (
            <TurnView key={t.id} turn={t} streaming={t.running ? streaming : undefined} />
          ))}
          {review && <PlanReview review={review} onDone={() => setReview(undefined)} />}
        </div>
      )}
      {state.setup && <SetupBanner setup={state.setup} />}
      <Composer state={state} mentions={mentions} clearMentions={() => setMentions([])} insert={insert} userCommands={userCommands} />
    </div>
  );
}

function Header({ state, showHistory, toggleHistory }: { state: ViewState; showHistory: boolean; toggleHistory: () => void }) {
  return (
    <div className="header">
      <div className="title" title={state.title}>
        {showHistory ? "Conversations" : state.title || "New conversation"}
      </div>
      <button className={`icon-btn ${showHistory ? "on" : ""}`} title="Past conversations" onClick={toggleHistory}>
        <Icon name="history" />
      </button>
      <button className="icon-btn" title="New conversation" disabled={state.running} onClick={() => post({ type: "newChat" })}>
        <Icon name="add" />
      </button>
    </div>
  );
}

function History({ sessions, current, close }: { sessions: SessionInfo[]; current: string; close: () => void }) {
  if (!sessions.length) return <div className="history empty-note">No past conversations yet.</div>;
  return (
    <div className="history">
      {sessions.map((s) => (
        <div key={s.id} className={`history-row ${s.id === current ? "current" : ""}`} onClick={() => (post({ type: "openSession", id: s.id }), close())}>
          <Icon name="comment-discussion" />
          <span className="history-title">{s.title}</span>
          <span className="history-time">{ago(s.updatedAt)}</span>
          <button
            className="icon-btn small"
            title="Delete"
            onClick={(e) => {
              e.stopPropagation();
              post({ type: "deleteSession", id: s.id });
            }}
          >
            <Icon name="trash" />
          </button>
        </div>
      ))}
    </div>
  );
}

function Welcome({ state }: { state: ViewState }) {
  return (
    <div className="welcome">
      <div className="welcome-mark">
        <Icon name="hubot" />
      </div>
      <div className="welcome-title">Agent Lolo</div>
      <div className="welcome-sub">
        Running on <b>{state.model}</b>, entirely on your machine.
      </div>
      <ul className="welcome-tips">
        <li>
          <code>@</code> attach files, <code>@problems</code>, <code>@git</code>, <code>@terminal</code>
        </li>
        <li>
          <code>/</code> commands · <kbd>Shift</kbd>+<kbd>Tab</kbd> switch mode · <kbd>Esc</kbd> stop
        </li>
        <li>Plan mode first for bigger changes, then “Run this plan”.</li>
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Transcript

function TurnView({ turn, streaming }: { turn: Turn; streaming?: { thought: string; answer?: string } }) {
  const status = turn.items.find((i) => i.kind === "status");
  return (
    <div className="turn">
      {turn.items.map((item, i) => (
        <ItemView key={i} item={item} turnId={turn.id} running={turn.running} />
      ))}
      {turn.running && !turn.items.some((i) => (i.kind === "approval" && i.state === "pending") || (i.kind === "question" && i.answer === undefined)) && (
        <Live
          started={Number(turn.id)}
          text={streaming?.answer ? "" : streaming?.thought || (status?.kind === "status" ? status.text : "Thinking")}
          answer={streaming?.answer}
        />
      )}
    </div>
  );
}

/** Claude-style working indicator: ✻ Thinking… (12s · esc to interrupt). */
function Live({ started, text, answer }: { started: number; text: string; answer?: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.round((now - started) / 1000));
  return (
    <>
      {answer && (
        <Row dot="assistant">
          <Markdown text={answer} />
        </Row>
      )}
      <div className="live">
        <span className="live-star">✻</span>
        <span className="live-text">{text ? `${text.replace(/\s+/g, " ").slice(0, 140)}…` : "Writing…"}</span>
        <span className="live-meta">
          ({secs}s · <kbd>esc</kbd> to interrupt)
        </span>
      </div>
    </>
  );
}

function Row({ dot, children }: { dot: "assistant" | "ok" | "bad" | "muted" | "run"; children: React.ReactNode }) {
  return (
    <div className="row">
      <span className={`dot ${dot}`} />
      <div className="row-body">{children}</div>
    </div>
  );
}

function ItemView({ item, turnId, running }: { item: Item; turnId: string; running: boolean }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="user-msg">
          {(item.context?.length || item.images || item.mode !== "agent") && (
            <div className="chips">
              {!!item.images && (
                <span className="chip">
                  <Icon name="file-media" /> {item.images === 1 ? "1 image" : `${item.images} images`}
                </span>
              )}
              {item.context?.map((f) => (
                <span className="chip" key={f} title={f} onClick={() => post({ type: "openFile", path: f })}>
                  <Icon name="file-code" /> {basename(f)}
                </span>
              ))}
              {item.mode !== "agent" && <span className="chip muted">{item.mode === "plan" ? "Plan mode" : "Read-only"}</span>}
            </div>
          )}
          <div className="user-text">{item.text}</div>
        </div>
      );
    case "status":
      return null;
    case "plan":
      return (
        <Row dot="assistant">
          <div className="todo-head">Plan{item.goal ? <span className="todo-goal"> · {item.goal}</span> : null}</div>
          <ul className="todos">
            {item.todos.map((t, i) => (
              <li key={i} className={item.states[i]}>
                <Icon name={item.states[i] === "done" ? "pass-filled" : item.states[i] === "failed" ? "error" : item.states[i] === "active" ? "circle-large-filled" : "circle-large-outline"} />
                <span>{t}</span>
              </li>
            ))}
          </ul>
        </Row>
      );
    case "thought":
      return (
        <Row dot="muted">
          <div className="thought">{item.text}</div>
        </Row>
      );
    case "tool":
      return <ToolRow verb={TOOL_VERB[item.tool] ?? mcpLabel(item.tool)} target={item.target} summary={summaryOf(item.title)} ok={item.ok} output={item.output} />;
    case "verify":
      return <ToolRow verb="Check" target={firstLine(item.output).replace(/^\$ /, "")} summary={item.ok ? "passed" : "failed"} ok={item.ok} output={item.output} openInitially={!item.ok} />;
    case "invalid":
      return (
        <Row dot="muted">
          <div className="note warn">{item.text}</div>
        </Row>
      );
    case "error":
      return (
        <Row dot="bad">
          <div className="note bad">{item.text}</div>
        </Row>
      );
    case "question":
      return <QuestionCard item={item} />;
    case "approval":
      return <ApprovalCard item={item} live={running} />;
    case "result":
      return (
        <Row dot={item.status === "done" || item.status === "planned" ? "assistant" : item.status === "cancelled" ? "muted" : "bad"}>
          <Markdown text={item.summary} />
          <div className="result-meta">
            {item.changed.map((f) => (
              <span className="chip" key={f} onClick={() => post({ type: "openFile", path: f })} title="Open file">
                <Icon name="file-code" /> {basename(f)}
              </span>
            ))}
            <span className="stats">
              {item.status === "done" || item.status === "planned" ? "" : `${item.status} · `}
              {item.stats}
            </span>
            {item.checkpoint && item.changed.length > 0 && (
              <button className="link" title="Restore all files to how they were before this message" onClick={() => post({ type: "restore", checkpoint: item.checkpoint! })}>
                <Icon name="discard" /> Restore
              </button>
            )}
          </div>
          {item.status === "planned" && (
            <button className="primary run-plan" disabled={running} onClick={() => post({ type: "runPlan", turnId })}>
              <Icon name="play" /> Run this plan
            </button>
          )}
        </Row>
      );
  }
}

function ToolRow({ verb, target, summary, ok, output, openInitially }: { verb: string; target?: string; summary: string; ok: boolean; output: string; openInitially?: boolean }) {
  const [open, setOpen] = useState(!!openInitially);
  return (
    <Row dot={ok ? "ok" : "bad"}>
      <div className="tool-line" onClick={() => setOpen(!open)} title={open ? "Hide output" : "Show output"}>
        <b>{verb}</b>
        {target && <span className="tool-target">{target}</span>}
      </div>
      <div className={`tool-sum ${ok ? "" : "bad"}`} onClick={() => setOpen(!open)}>
        <span className="elbow">⎿</span> {summary}
        <Icon name={open ? "chevron-up" : "chevron-down"} />
      </div>
      {open && <pre className="tool-out">{output}</pre>}
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Permission and question cards (Claude-style numbered options)

const ACTION_TITLE = { edit: "Edit file", create: "Create file", command: "Bash command" } as const;

function ApprovalCard({ item, live }: { item: Extract<Item, { kind: "approval" }>; live: boolean }) {
  const pending = item.state === "pending" && live;
  const [sel, setSel] = useState(0);
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (pending) card.current?.focus();
  }, [pending]);

  const decide = (decision: "yes" | "always" | "no", fb?: string) => post({ type: "approval", id: item.id, decision, feedback: fb });
  const prefix = item.target.trim().split(/\s+/).slice(0, 2).join(" ");
  const options = [
    { label: "Yes", run: () => decide("yes") },
    { label: item.action === "command" ? `Yes, and don't ask again for ${prefix} commands` : "Yes, allow all edits during this session", run: () => decide("always") },
    { label: "No, and tell Agent Lolo what to do differently", run: () => setRejecting(true) },
  ];
  const question =
    item.action === "command" ? "Do you want to run this command?" : item.action === "create" ? `Do you want to create ${basename(item.target)}?` : `Do you want to make this edit to ${basename(item.target)}?`;

  const onKey = (e: React.KeyboardEvent) => {
    if (!pending || rejecting) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => (s + (e.key === "ArrowDown" ? 1 : 2)) % 3);
    } else if (e.key === "Enter") {
      e.preventDefault();
      options[sel].run();
    } else if (["1", "2", "3"].includes(e.key)) options[Number(e.key) - 1].run();
    else if (e.key === "Escape") {
      e.stopPropagation();
      setRejecting(true);
    }
  };

  if (!pending) {
    return (
      <Row dot={item.state === "no" ? "bad" : "ok"}>
        <div className="tool-line">
          <b>{item.action === "command" ? "Bash" : item.action === "create" ? "Create" : "Update"}</b>
          <span className="tool-target">{item.target}</span>
        </div>
        <div className={`tool-sum ${item.state === "no" ? "bad" : ""}`}>
          <span className="elbow">⎿</span>{" "}
          {item.state === "pending"
            ? "not decided (run ended)"
            : item.state === "no"
              ? `Rejected${item.feedback ? `: ${item.feedback}` : ""}`
              : item.state === "always"
                ? "Approved · won't ask again this session"
                : "Approved"}
        </div>
        {item.action !== "command" && item.state !== "no" && <DiffView diff={item.detail} collapsed />}
      </Row>
    );
  }

  return (
    <div className="perm" tabIndex={0} ref={card} onKeyDown={onKey}>
      <div className="perm-head">
        <span>{ACTION_TITLE[item.action]}</span>
        {item.action !== "command" && (
          <button className="link" onClick={() => post({ type: "openDiff", id: item.id })}>
            <Icon name="diff" /> Open diff
          </button>
        )}
      </div>
      {item.action === "command" ? (
        <>
          <pre className="cmd">{item.target}</pre>
          <div className="perm-reason">{item.detail}</div>
        </>
      ) : (
        <>
          <div className="perm-path">{item.target}</div>
          <DiffView diff={item.detail} />
        </>
      )}
      <div className="perm-question">{question}</div>
      {rejecting ? (
        <div className="perm-feedback">
          <input
            autoFocus
            value={feedback}
            placeholder="Tell Agent Lolo what to do instead (optional) · Enter"
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") decide("no", feedback);
              if (e.key === "Escape") setRejecting(false);
            }}
          />
          <button className="primary" onClick={() => decide("no", feedback)}>
            Send
          </button>
        </div>
      ) : (
        <div className="options">
          {options.map((o, i) => (
            <div key={i} className={`option ${i === sel ? "sel" : ""}`} onMouseEnter={() => setSel(i)} onClick={o.run}>
              <span className="caret">{i === sel ? "❯" : ""}</span>
              <span className="num">{i + 1}.</span>
              <span className="option-label">
                {o.label}
                {i === 2 && <span className="hint"> (esc)</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DiffView({ diff, collapsed }: { diff: string; collapsed?: boolean }) {
  const [open, setOpen] = useState(!collapsed);
  const lines = diff.split("\n");
  const added = lines.filter((l) => l.startsWith("+")).length;
  const removed = lines.filter((l) => l.startsWith("-")).length;
  if (!open) {
    return (
      <div className="diff-toggle" onClick={() => setOpen(true)}>
        <span className="add-n">+{added}</span> <span className="del-n">−{removed}</span> <Icon name="chevron-down" />
      </div>
    );
  }
  return (
    <pre className="diff" onClick={collapsed ? () => setOpen(false) : undefined}>
      {lines.map((l, i) => (
        <div key={i} className={l.startsWith("@@") ? "hunk" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : ""}>
          {l || " "}
        </div>
      ))}
    </pre>
  );
}

function QuestionCard({ item }: { item: Extract<Item, { kind: "question" }> }) {
  const [text, setText] = useState("");
  const send = (value: string | null) => post({ type: "answer", text: value });
  if (item.answer !== undefined) {
    return (
      <Row dot="assistant">
        <div className="thought">{item.text}</div>
        <div className="tool-sum">
          <span className="elbow">⎿</span> {item.answer ?? "(skipped)"}
        </div>
      </Row>
    );
  }
  return (
    <div className="perm">
      <div className="perm-question">{item.text}</div>
      <div className="perm-feedback">
        <input autoFocus value={text} placeholder="Your answer · Enter" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && text.trim() && send(text)} />
        <button className="secondary" onClick={() => send(null)}>
          Skip
        </button>
        <button className="primary" disabled={!text.trim()} onClick={() => send(text)}>
          Answer
        </button>
      </div>
    </div>
  );
}

function PlanReview({ review, onDone }: { review: { todos: string[]; goal?: string }; onDone: () => void }) {
  const [todos, setTodos] = useState(review.todos);
  const decide = (run: boolean) => {
    post({ type: "planDecision", todos: run ? todos.map((t) => t.trim()).filter(Boolean) : null });
    onDone();
  };
  return (
    <div className="perm">
      <div className="perm-head">
        <span>Review the plan</span>
      </div>
      {review.goal && <div className="perm-reason">{review.goal}</div>}
      {todos.map((t, i) => (
        <div className="perm-feedback" key={i}>
          <span className="num">{i + 1}.</span>
          <input value={t} onChange={(e) => setTodos(todos.map((x, j) => (j === i ? e.target.value : x)))} />
          <button className="icon-btn small" title="Remove step" onClick={() => setTodos(todos.filter((_, j) => j !== i))}>
            <Icon name="close" />
          </button>
        </div>
      ))}
      <div className="perm-actions">
        <button className="link" onClick={() => setTodos([...todos, ""])} disabled={todos.length >= 6}>
          <Icon name="add" /> Add step
        </button>
        <span className="spacer" />
        <button className="secondary" onClick={() => decide(false)}>
          Cancel
        </button>
        <button className="primary" onClick={() => decide(true)} disabled={!todos.some((t) => t.trim())}>
          Run
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer

function Composer({
  state,
  mentions,
  clearMentions,
  insert,
  userCommands,
}: {
  state: ViewState;
  mentions: { label: string; detail?: string }[];
  clearMentions: () => void;
  insert?: { text: string; n: number };
  userCommands: { cmd: string; hint: string }[];
}) {
  const [text, setText] = useState(() => uiState.get("draft", ""));
  const [images, setImages] = useState<string[]>([]);
  const [query, setQuery] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [menu, setMenu] = useState<"mode" | null>(null);
  const [detached, setDetached] = useState<string | undefined>();
  const area = useRef<HTMLTextAreaElement>(null);
  const mode = uiModeOf(state);
  const modeInfo = UI_MODES.find((m) => m.id === mode)!;
  const includeActive = !!state.activeFile && detached !== state.activeFile;

  useEffect(() => uiState.set("draft", text), [text]);
  useEffect(() => {
    if (!insert) return;
    setText((t) => (t && !t.endsWith(" ") ? `${t} ` : t) + insert.text);
    area.current?.focus();
  }, [insert]);
  // Auto-grow the textarea up to ~10 lines.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);
  // Esc stops a run from anywhere in the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && state.running && !document.querySelector(".perm")) post({ type: "cancel" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.running]);

  // User commands (.agent/commands, MCP prompts) are inserted with a space so arguments can follow.
  const slash = useMemo(() => {
    if (!/^\/\S*$/.test(text)) return [];
    const user = userCommands.map((c) => ({ cmd: c.cmd, hint: c.hint, run: () => undefined, insert: true }));
    return [...SLASH.map((c) => ({ ...c, insert: false })), ...user].filter((c) => c.cmd.startsWith(text));
  }, [text, userCommands]);
  useEffect(() => {
    if (text === "/") post({ type: "slashQuery" });
  }, [text]);
  const popup: { label: string; detail?: string; pick: () => void }[] = slash.length
    ? slash.map((c) => ({ label: c.cmd, detail: c.hint, pick: () => (c.insert ? (setText(`${c.cmd} `), area.current?.focus()) : (c.run(), setText(""))) }))
    : query !== null
      ? mentions.map((m) => ({ label: `@${m.label}`, detail: m.detail, pick: () => pickMention(m.label) }))
      : [];

  const onChange = (v: string) => {
    setText(v);
    setSel(0);
    const caret = area.current?.selectionStart ?? v.length;
    const m = /(?:^|\s)@([\w./:-]*)$/.exec(v.slice(0, caret));
    if (m) {
      setQuery(m[1]);
      post({ type: "mentionQuery", query: m[1] });
    } else {
      setQuery(null);
      clearMentions();
    }
  };

  const pickMention = (label: string) => {
    const caret = area.current?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/@([\w./:-]*)$/, `@${label}${label.endsWith(":") ? "" : " "}`);
    setText(before + text.slice(caret));
    setQuery(null);
    clearMentions();
    area.current?.focus();
  };

  const send = () => {
    if ((!text.trim() && !images.length) || state.running) return;
    post({ type: "send", text: text.trim(), mode: state.mode, includeActiveFile: includeActive, images: images.length ? images.map((i) => i.split(",")[1]) : undefined });
    setText("");
    setImages([]);
  };

  // Pasted screenshots (data URLs) go with the next message; vision models only.
  const onPaste = (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.items].filter((i) => i.type.startsWith("image/")).map((i) => i.getAsFile()).filter((f): f is File => !!f);
    if (!files.length) return;
    e.preventDefault();
    for (const f of files.slice(0, 4)) {
      const reader = new FileReader();
      reader.onload = () => setImages((list) => (list.length < 4 ? [...list, String(reader.result)] : list));
      reader.readAsDataURL(f);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (popup.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setSel((s) => (s + (e.key === "ArrowDown" ? 1 : popup.length - 1)) % popup.length);
    } else if (popup.length && (e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
      e.preventDefault();
      popup[sel].pick();
    } else if (popup.length && e.key === "Escape") {
      setQuery(null);
      clearMentions();
      if (slash.length) setText("");
    } else if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      const i = UI_MODES.findIndex((m) => m.id === mode);
      setUiMode(UI_MODES[(i + 1) % UI_MODES.length].id);
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const models = state.models.includes(state.model) ? state.models : [state.model, ...state.models];
  const placeholder = state.mode === "ask" ? "Ask about the code…" : state.mode === "plan" ? "Describe what to plan…" : "Ask Agent Lolo to do something… (@ files, / commands)";

  return (
    <div className="composer-wrap">
      {popup.length > 0 && (
        <div className="popup">
          {popup.map((p, i) => (
            <div key={p.label} className={i === sel ? "sel" : ""} onMouseEnter={() => setSel(i)} onMouseDown={(e) => (e.preventDefault(), p.pick())}>
              <span className="popup-label">{p.label}</span>
              {p.detail && <span className="popup-detail">{p.detail}</span>}
            </div>
          ))}
        </div>
      )}
      {menu === "mode" && (
        <div className="popup mode-menu" onMouseLeave={() => setMenu(null)}>
          {UI_MODES.map((m) => (
            <div key={m.id} className={m.id === mode ? "sel" : ""} onMouseDown={(e) => (e.preventDefault(), setUiMode(m.id), setMenu(null))}>
              <Icon name={m.icon} />
              <span className="popup-label">{m.label}</span>
              <span className="popup-detail">{m.hint}</span>
            </div>
          ))}
        </div>
      )}
      <div className={`composer ${state.running ? "busy" : ""}`}>
        {!!images.length && (
          <div className="attachments">
            {images.map((src, i) => (
              <span className="thumb" key={i}>
                <img src={src} alt={`pasted image ${i + 1}`} />
                <button className="icon-btn" title="Remove" onClick={() => setImages((l) => l.filter((_, j) => j !== i))}>
                  <Icon name="close" />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea ref={area} rows={1} value={text} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} onPaste={onPaste} />
        <div className="toolbar">
          <button className="icon-btn" title="Attach a file" onClick={() => post({ type: "pickFile" })}>
            <Icon name="add" />
          </button>
          <button className="icon-btn" title="Commands" onClick={() => (setText("/"), area.current?.focus())}>
            <span className="slash">/</span>
          </button>
          <label className="chip select-chip" title="Model">
            <Icon name="chip" />
            <select value={state.model} disabled={state.running} onChange={(e) => post({ type: "setModel", model: e.target.value })}>
              {models.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          {state.activeFile &&
            (includeActive ? (
              <span className="chip file-chip" title={`${state.activeFile} is attached as context`}>
                <Icon name="file-code" /> <span className="chip-name">{basename(state.activeFile)}</span>
                <span className="chip-x" title="Don't attach" onClick={() => setDetached(state.activeFile)}>
                  <Icon name="close" />
                </span>
              </span>
            ) : (
              <span className="chip muted file-chip" title="Attach the active file" onClick={() => setDetached(undefined)}>
                <Icon name="add" /> <span className="chip-name">{basename(state.activeFile)}</span>
              </span>
            ))}
          <span className="spacer" />
          <ContextMeter used={state.context?.used ?? 0} total={state.context?.total ?? 0} />
          <button className={`mode-chip ${mode}`} title={`${modeInfo.label}: ${modeInfo.hint} · Shift+Tab to switch`} onClick={() => setMenu(menu ? null : "mode")}>
            <Icon name={modeInfo.icon} /> <span className="label">{modeInfo.label}</span>
          </button>
          {state.running ? (
            <button className="send stop" title="Stop (Esc)" onClick={() => post({ type: "cancel" })}>
              <Icon name="debug-stop" />
            </button>
          ) : (
            <button className="send" title="Send (Enter)" disabled={!text.trim() && !images.length} onClick={send}>
              <Icon name="arrow-up" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** First-run problems with the one action that fixes each. */
function SetupBanner({ setup }: { setup: NonNullable<ViewState["setup"]> }) {
  const other = setup.installed.filter((m) => m !== setup.model);
  return (
    <div className="setup">
      <Icon name="warning" />
      <div className="setup-body">
        {setup.problem === "no-server" ? (
          <>
            <b>Can't reach Ollama</b> at <code>{setup.endpoint}</code>. Install it from <b>ollama.com</b> and start it, or set another endpoint.
          </>
        ) : (
          <>
            Model <code>{setup.model}</code> is not installed.
          </>
        )}
        <div className="setup-actions">
          {setup.problem === "no-model" && (
            <button className="primary" onClick={() => post({ type: "setup", action: "pull" })}>
              <Icon name="cloud-download" /> Download {setup.model}
            </button>
          )}
          {setup.problem === "no-model" &&
            other.slice(0, 2).map((m) => (
              <button key={m} className="secondary" onClick={() => post({ type: "setModel", model: m })}>
                Use {m}
              </button>
            ))}
          <button className="secondary" onClick={() => post({ type: "setup", action: "retry" })}>
            <Icon name="refresh" /> Retry
          </button>
          {setup.problem === "no-server" && (
            <button className="link" onClick={() => post({ type: "setup", action: "settings" })}>
              Settings
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Claude Code-style context indicator: a ring plus "12.4k / 64k". */
function ContextMeter({ used, total }: { used: number; total: number }) {
  if (!total) return null;
  const frac = Math.min(1, used / total);
  const r = 6;
  const c = 2 * Math.PI * r;
  const level = frac > 0.9 ? "bad" : frac > 0.7 ? "warn" : "";
  return (
    <span
      className={`ctx ${level}`}
      title={
        used
          ? `Context: ${used.toLocaleString()} of ${total.toLocaleString()} tokens (${Math.round(frac * 100)}%) in the last step. Older steps are summarized automatically when it fills up.`
          : `Context window: ${total.toLocaleString()} tokens. Usage appears after the first step.`
      }
    >
      <svg width="16" height="16" viewBox="0 0 16 16">
        <circle cx="8" cy="8" r={r} className="ctx-track" />
        <circle cx="8" cy="8" r={r} className="ctx-fill" strokeDasharray={`${c * frac} ${c}`} transform="rotate(-90 8 8)" />
      </svg>
      <span className="ctx-text">
        {tokens(used)} / {tokens(total, true)}
      </span>
    </span>
  );
}

/** 5230 → "5.2k"; context windows are powers of two, so 65536 → "64k". */
function tokens(n: number, window = false) {
  if (window && n % 1024 === 0) return `${n / 1024}k`;
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

// ---------------------------------------------------------------------------

function basename(p: string) {
  return p.slice(p.lastIndexOf("/") + 1);
}

function firstLine(s: string) {
  return s.split("\n")[0] ?? "";
}

/** "read_file src/a.ts: 21 lines; class Cart" → "21 lines; class Cart". */
function summaryOf(title: string) {
  const i = title.indexOf(": ");
  return i >= 0 ? title.slice(i + 2) : title;
}

function ago(t: number) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

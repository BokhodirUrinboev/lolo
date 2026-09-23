# Local Agent

A local-first AI coding agent for VS Code, built for small local models (7B–14B, e.g. `qwen2.5-coder` with a 32k context) served by Ollama or any OpenAI-compatible server (llama.cpp, LM Studio, vLLM).

The quality comes from orchestration, not from the model. The extension gathers context itself, constrains every tool call with a JSON schema, applies edits defensively and verifies them. The model only makes one small, checkable decision per step.

## Features

- **Agent chat** (sidebar), a conversation like Claude Code: follow-ups see the earlier turns ("now add tests", "what did you change?", "ishni boshla" after a plan). Ask (read-only), Agent (plan → act → verify → repair) and Plan modes; a plan gets a **Run this plan** button. Greetings get a direct reply, questions get a read-only answer, only real requests start a task.
- **Permission cards** in the chat, like Claude Code: every edit shows its diff with **Yes / Yes, allow all edits this session / No (and tell the agent what to do instead)**; commands outside the allowlist the same way ("don't ask again for `dotnet new`"). "Auto-accept edits" toggle in the composer. Keys 1/2/3.
- **Guard rails for small models**: servers and watchers (`dotnet run` on web projects, `npm start/dev`, ...) are refused; commands time out after 2 minutes; the project's build/type check runs automatically when a todo finishes (detected from `.sln`/`.csproj`, `tsconfig.json`, `Cargo.toml`, `go.mod`, Python); the environment (OS, date, installed SDK versions) is in the prompt so the model doesn't downgrade frameworks.
- **@-mentions**: `@path/to/file`, `@folder/`, `@symbol:Name`, `@problems`, `@git`, `@terminal`.
- **Inline diff review** (Ctrl+I, Apply on chat code blocks, and agent runs started without the chat): red/green hunks in the editor with **Accept / Reject** per hunk, Accept all (Tab), Reject all (Esc). Edits go through `WorkspaceEdit`, so native undo works.
- **Checkpoints**: before every run the workspace is snapshotted into a shadow git repo (`.agent/checkpoints`). Your own git is never touched. Any run can be restored with one click.
- **Ctrl+I inline edit**: rewrites the selection from an instruction and shows the result as an inline diff.
- **Autocomplete**: ghost-text completion using the model's native FIM tokens, with the signatures of imported files as extra context.
- **Eval harness and trajectory logs**: every run is logged as JSONL (`.agent/trajectories`). The eval runner reports tool-call validity, edit apply rate and task pass rate, and passing runs can be exported as a fine-tuning dataset.

## Requirements

- An Ollama server (default `http://localhost:11434`) with a coder model, for example:
  ```
  ollama pull qwen2.5-coder:7b
  ```
  For a 32k context, create a variant with `PARAMETER num_ctx 32768`. The default model name is `qwen2.5-coder-32k:latest`.
- `git` on PATH (for checkpoints).
- Optional: a small, fast model for autocomplete (`ollama pull qwen2.5-coder:1.5b`), set in `localAgent.autocomplete.model`.

## Project rules

Put conventions and checks in `.agent/rules.md`. The file is always included in the prompt. Lines of the form `verify: <command>` are run automatically when the agent finishes a todo that changed files; failures are fed back for repair (up to 3 attempts):

```markdown
- C#: file-scoped namespaces, no `var` for primitives.
- verify: dotnet build -v q -nologo
- verify: dotnet test --no-build
```

## Language

Messages can be in any language, but small coder models understand English best: qwen2.5-coder:7b misreads many Uzbek sentences. The extension adds English hints for common Uzbek developer words and decides some things without the model (a short "ha / boshla / ok" after a plan runs it; a message with a question word is answered, never turned into edits), but for anything non-trivial English (or Russian) gives noticeably better results, as does a larger model.

## Settings

| Setting | Default | |
|---|---|---|
| `localAgent.provider` | `ollama` | `ollama` or `openai` (OpenAI-compatible) |
| `localAgent.endpoint` | `http://localhost:11434` | For `openai`, the base URL ending in `/v1` |
| `localAgent.model` | `qwen2.5-coder-32k:latest` | Also selectable in the chat header |
| `localAgent.profiles` | `[]` | Model profile overrides: `{ "match": "<model id prefix>", "ctx": 32768, "editFormat": "auto", "wholeFileMaxLines": 150, ... }` |
| `localAgent.autoApproveEdits` | `false` | Skip the inline review (a checkpoint is still taken) |
| `localAgent.reviewPlan` | `false` | Stop for plan review before every Agent run (Plan mode + "Run this plan" covers the usual case) |
| `localAgent.commandAllowlist` | build/test commands | Commands `run_command` may run without asking; dangerous patterns (`rm -rf`, `sudo`, `git push --force`, ...) are always blocked |
| `localAgent.autocomplete.*` | enabled, 250 ms debounce | `model`, `debounceMs`, `maxTokens` |

## Commands and keys

| | |
|---|---|
| `Ctrl+I` / `Cmd+I` | Edit selection |
| `Tab` / `Esc` | Accept all / reject all pending inline changes |
| Local Agent: Run Task / Ask / Plan Only | Start a run from the command palette |
| Local Agent: Restore Checkpoint | Pick a checkpoint and restore the workspace |
| Local Agent: Toggle Autocomplete | |

## Headless CLI and eval

```
npm run build
node dist/cli.js --root <project> [-y] [--mode agent|ask|plan] "task"
node dist/cli.js --root <project> --chat [-y]     # conversation; /ask /plan /agent prefixes, /run, /new, /exit
node dist/cli.js --root <project> --checkpoints | --restore <id>
node dist/eval.js run [--filter id] [--runs n] [--model m]
node dist/eval.js export --out dataset.jsonl eval/results/<run>
```

An eval task is a folder in `eval/tasks/<id>/` containing `task.json` (`{ "task", "check" }`), `repo/` (the starting state) and `check/` (hidden tests, copied in after the agent finishes).

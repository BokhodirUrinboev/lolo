# Agent Lolo

**A coding agent for VS Code that runs entirely on your machine.** It is built for small local models (7B–14B) served by [Ollama](https://ollama.com), llama.cpp, LM Studio or vLLM: no cloud, no API keys, no telemetry.

![Agent Lolo: plan, tool calls and an edit waiting for approval](media/screenshots/approval.png)

Most coding agents are designed for large cloud models and fall apart on a 7B model. Agent Lolo moves the hard parts into code: it gathers the context itself, constrains every tool call with a JSON schema, applies edits defensively, rejects edits that break the syntax, and runs your build or tests before calling a task done. The model only makes one small, checkable decision per step.

> **Preview.** Tested on Linux with `qwen2.5-coder:7b` and `qwen3.5:9b`. macOS should work; Windows is experimental. Feedback and issues are welcome.

## Quick start

1. Install [Ollama](https://ollama.com) and start it.
2. Download a model:
   ```
   ollama pull qwen2.5-coder:7b
   ```
   (If it's missing, the chat offers a **Download** button.)
3. Open **Agent Lolo** in the activity bar and describe what you want.

## What it does

**Plans, edits and checks its own work.** Ask for a change and the agent makes a short plan, reads the files it needs, edits them, and runs your project's build/type check (or the tests you configure) before it finishes. If the check fails, it repairs the code.

**Asks before it touches anything.** Every edit shows its diff; every command outside your allowlist needs approval:

- **Yes**
- **Yes, allow all edits this session** (or "don't ask again for `dotnet new` commands")
- **No, and tell the agent what to do instead**

Keys: `1` `2` `3`, arrows and Enter, `Esc`.

![Plan mode, then running the plan with a command approval](media/screenshots/plan.png)

**Four modes**, switched with `Shift+Tab` in the chat:

| Mode | |
|---|---|
| Ask before edits | Plans and edits, asks before every change (default) |
| Edit automatically | Applies edits without asking |
| Plan mode | Only proposes a plan; press **Run this plan** when it looks right |
| Read-only | Answers questions about your code, never edits |

**Undo anything.** Before every run, the workspace is snapshotted into a separate shadow git repository (`.agent/checkpoints`). Your own git history is never touched. Click **Restore** under any answer to go back.

**It's a conversation.** Follow-ups see the earlier messages ("now add tests", "why did you change that?", "go" after a plan). Greetings get a reply, questions get a read-only answer, and only real requests start editing. Past conversations are kept in the history menu.

**Also included:**

- `@`-mentions: `@path/to/file`, `@folder/`, `@symbol:Name`, `@problems`, `@git`, `@terminal`
- `Ctrl+I` / `Cmd+I`: rewrite the selection from an instruction and review it as an inline diff (`Tab` accepts, `Esc` rejects)
- Autocomplete (ghost text) using the model's fill-in-the-middle tokens
- A context usage indicator, and a repository map (built with tree-sitter) so the model knows your code's structure
- Guard rails: server and watch commands (`npm run dev`, `dotnet run` on web projects, ...) are refused, commands time out after 2 minutes, and dangerous commands (`rm -rf`, `sudo`, `git push --force`, ...) are always blocked

![Welcome screen](media/screenshots/welcome.png)

## Choosing a model

| Model | VRAM | Notes |
|---|---|---|
| `qwen2.5-coder:7b` (default) | ~6 GB | Fastest; also powers autocomplete |
| `qwen3.5:9b` | ~8 GB | Noticeably more accurate (solved every task in our evaluation set), long context is cheap; about 30% slower |

Pick the model in the chat. With `qwen3.5` as the chat model, autocomplete automatically uses an installed coder model. Any other Ollama or OpenAI-compatible model works too; set a per-model profile in `localAgent.profiles` if it needs a different context size.

You also need `git` on your PATH (for checkpoints).

## Project rules

Put conventions and checks in `.agent/rules.md`; it is always part of the prompt. `verify:` lines run automatically when the agent finishes a change, and failures are fed back for repair:

```markdown
- C#: file-scoped namespaces.
- verify: dotnet build -v q -nologo
- verify: dotnet test --no-build
```

Without `verify:` lines, the agent picks a check from your project files (`.sln`/`.csproj`, `tsconfig.json`, `Cargo.toml`, `go.mod`, Python).

## Privacy

Everything runs locally: your prompts and code go only to the model server you configure (by default Ollama on `localhost`). The extension sends no telemetry. Run logs are written to `.agent/trajectories` in your workspace (git-ignored automatically), so you can see exactly what the agent did.

## Language

You can write in any language, but small coder models understand English best. For Uzbek, the extension adds English hints for common developer words and understands short confirmations ("ha", "boshla", "ok") on its own; for anything complex, English or Russian works better, as does a larger model.

## Settings

| Setting | Default | |
|---|---|---|
| `localAgent.provider` | `ollama` | `ollama` or `openai` (OpenAI-compatible) |
| `localAgent.endpoint` | `http://localhost:11434` | For `openai`, the base URL ending in `/v1` |
| `localAgent.model` | `qwen2.5-coder:7b` | Also selectable in the chat |
| `localAgent.profiles` | `[]` | Per-model overrides, e.g. `{ "match": "qwen3.5", "ctx": 131072 }` |
| `localAgent.autoApproveEdits` | `false` | Apply edits without asking (a checkpoint is still taken) |
| `localAgent.commandAllowlist` | build/test commands | Commands the agent may run without asking |
| `localAgent.maxStepsPerTodo` | `15` | Step limit per plan item |
| `localAgent.autocomplete.*` | enabled | `model`, `debounceMs`, `maxTokens` |

## Commands and keys

| | |
|---|---|
| `Shift+Tab` (chat) | Switch mode |
| `Esc` (chat) | Stop the running task |
| `/` (chat) | Commands: `/new`, `/plan`, `/auto`, `/restore`, ... |
| `Ctrl+I` / `Cmd+I` | Edit the selection |
| `Tab` / `Esc` (editor) | Accept / reject pending inline changes |
| Agent Lolo: Restore Checkpoint | Restore the workspace to an earlier checkpoint |
| Agent Lolo: Toggle Autocomplete | |

## Contributing

Source, issues and the evaluation harness are on [GitHub](https://github.com/Nodirbek-Abdulaxadov/lolo). `npm install && npm run build`, then press F5 in VS Code to run the extension.

## License

MIT

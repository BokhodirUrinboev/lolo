# Agent Lolo

An AI coding agent for VS Code that runs entirely on your machine, built to work well with **small local models** (7B–14B) served by Ollama or any OpenAI-compatible server (llama.cpp, LM Studio, vLLM).

Most agents are designed for large cloud models and fall apart on a 7B model. Agent Lolo moves the hard parts into code: it gathers the context itself, constrains every tool call with a JSON schema, applies edits defensively, rejects edits that break the syntax, and runs your build/tests before calling a task done. The model only makes one small, checkable decision per step.

> **Preview.** Tested on Linux with qwen2.5-coder:7b and qwen3.5:9b. macOS should work; Windows is experimental.

## Features

- **Agent chat** in the sidebar. It is a conversation: follow-ups see the earlier turns ("now add tests", "what did you change?", "go" after a plan). Greetings get a reply, questions get a read-only answer, and only real requests start a task.
- **Modes**: *Ask before edits*, *Edit automatically*, *Plan mode* (propose a plan, then **Run this plan**) and *Read-only*. Switch with Shift+Tab.
- **Permission prompts**: every edit shows its diff with *Yes / Yes, allow all edits this session / No, and tell the agent what to do instead*. Commands outside your allowlist are approved the same way.
- **Checkpoints**: the workspace is snapshotted before every run into a separate shadow git repository (`.agent/checkpoints`); your own git is never touched. Restore any run with one click.
- **Guard rails for small models**: server/watch commands (`npm run dev`, `dotnet run` on web projects, ...) are refused, commands time out after 2 minutes, dangerous commands (`rm -rf`, `sudo`, `git push --force`, ...) are always blocked, and your project's build/type check runs automatically when a task finishes.
- **@-mentions**: `@path/to/file`, `@folder/`, `@symbol:Name`, `@problems`, `@git`, `@terminal`.
- **Ctrl+I inline edit**: rewrite the selection from an instruction, review the result as an inline diff (Tab accepts, Esc rejects).
- **Autocomplete**: ghost-text completion using the model's fill-in-the-middle tokens.
- **Conversation history**, context usage indicator, and a repository map built with tree-sitter so the model knows your code structure.

## Getting started

1. Install [Ollama](https://ollama.com) and start it.
2. Download a model:
   ```
   ollama pull qwen2.5-coder:7b
   ```
   If the model is missing, the chat offers a **Download** button.
3. Open the **Agent Lolo** view in the activity bar and ask for something.

**Which model?** `qwen2.5-coder:7b` (default) runs on ~6 GB of VRAM and also powers autocomplete. `qwen3.5:9b` is noticeably more accurate (in our tests it solved every task in the evaluation set) and handles long context cheaply, at about 30% lower speed; pick it in the chat's model menu. With `qwen3.5` as the chat model, autocomplete automatically uses an installed coder model.

Also needed: `git` on your PATH (for checkpoints).

## Project rules

Put conventions and checks in `.agent/rules.md`; it is always part of the prompt. Lines of the form `verify: <command>` run automatically when the agent finishes a change, and failures are fed back for repair:

```markdown
- C#: file-scoped namespaces.
- verify: dotnet build -v q -nologo
- verify: dotnet test --no-build
```

Without `verify:` lines, the agent detects a check from your project files (`.sln`/`.csproj`, `tsconfig.json`, `Cargo.toml`, `go.mod`, Python).

## Privacy

Everything runs locally: prompts and code go only to the model server you configure (by default Ollama on `localhost`). The extension has no telemetry. Run logs are written to `.agent/trajectories` in your workspace (git-ignored automatically) so you can inspect what the agent did.

## Language

You can write in any language, but small coder models understand English best. For Uzbek, the extension adds English hints for common developer words and handles short confirmations ("ha", "boshla", "ok") without the model; for anything complex, English or Russian gives better results, as does a larger model.

## Settings

| Setting | Default | |
|---|---|---|
| `localAgent.provider` | `ollama` | `ollama` or `openai` (OpenAI-compatible) |
| `localAgent.endpoint` | `http://localhost:11434` | For `openai`, the base URL ending in `/v1` |
| `localAgent.model` | `qwen2.5-coder:7b` | Also selectable in the chat |
| `localAgent.profiles` | `[]` | Per-model overrides, e.g. `{ "match": "qwen3.5", "ctx": 131072 }` for a larger context window |
| `localAgent.autoApproveEdits` | `false` | Apply edits without asking (a checkpoint is still taken) |
| `localAgent.commandAllowlist` | build/test commands | Commands the agent may run without asking |
| `localAgent.maxStepsPerTodo` | `15` | Step limit per plan item |
| `localAgent.autocomplete.*` | enabled | `model`, `debounceMs`, `maxTokens` |

## Commands and keys

| | |
|---|---|
| `Ctrl+I` / `Cmd+I` | Edit selection |
| `Tab` / `Esc` | Accept / reject pending inline changes |
| `Shift+Tab` (in the chat) | Switch mode |
| `Esc` (in the chat) | Stop the running task |
| Agent Lolo: Restore Checkpoint | Restore the workspace to an earlier checkpoint |
| Agent Lolo: Toggle Autocomplete | |

## Development

```
npm install && npm run build
npm test                                            # unit tests
node dist/cli.js --root <project> --chat            # headless agent conversation
node dist/eval.js run --model qwen3.5:9b --runs 2   # evaluation (task pass rate, edit apply rate, ...)
```

An eval task is a folder in `eval/tasks/<id>/` with `task.json` (`{ "task", "check" }`), `repo/` (the starting state) and `check/` (hidden tests, copied in after the agent finishes).

## License

MIT. The license text is included with the extension (LICENSE).

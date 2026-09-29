# Changelog

## 0.5.0

Stage 14 of the plan: Windows, a much larger evaluation, and the agent fixes it found.

**Windows.** Tested on Windows 11 (unit tests, the VS Code smoke test and the evaluation); CI now runs the tests and the smoke test on Linux, Windows and macOS.

- Commands run in Git Bash (installed with Git), so the `ls`, `grep`, `&&` and `test -f` that models write work; the agent's VS Code terminal is Git Bash too. Without Git Bash, cmd.exe, and the prompt says so.
- `python3` works when Windows only has the Microsoft Store placeholder for it.
- Background servers (`npm run dev`) are really stopped at the end of a task, and commands that time out are stopped with everything they started.
- Search results and build errors show workspace-relative paths with `/`.

**Fewer failed tasks with small models.** Each fix comes from a failing run of qwen2.5-coder:7b and is done by code:

- Edits: an ambiguous `search` uses the match in the function the task names (and `all=true` stays inside it); a `replace` that repeats the lines around `search`, or is a complete new version of the function, replaces instead of duplicating; line breaks escaped twice are repaired; placeholders like `// existing implementation` are refused; an edit already in place is not applied again. A file must be read before it is edited, as in Claude Code.
- Builds: missing C# `using` directives for framework types are added by code; failing builds and checks show the code at the error lines; `namespace X;` followed by braces is repaired.
- Plans: todos about the same file are merged, code in the todo list is refused, "read/identify/locate" todos and test todos nobody asked for are dropped, and moving a file is one todo (a later "fix the imports" todo completes by code once move_file did it). In the middle of a refactor, checks that fail because of a later todo run again after it. "Remember that …" always saves the fact.
- Tests: when the task is to make failing tests pass, the tests can't be edited.
- `node server.js`, `python app.py` and `go run .` of a server start it in the background instead of waiting 2 minutes.
- Replies that run away (a thought that never ends, one line repeated) are stopped while streaming instead of at the 4096-token limit.

**MCP.** `/mcp` lists every server's tools as a checklist; unchecked tools are never offered.

**Models.** Built-in settings for qwen2.5, qwen3, llama3, gemma3, mistral and deepseek-coder-v2 (32k context instead of 8k), and autocomplete tokens for deepseek-coder-v2, starcoder2 and codellama.

**Evaluation: 14 → 38 tasks**, each with hidden tests and a reference solution (`eval.js validate` checks both): .NET, multi-file refactors, TypeScript, failing-test fixes, git, memory, a background server tried with curl, MCP (a mock issue tracker), web (recorded pages) and a plan-then-"ok, do it" conversation. `eval.js fim` measures autocomplete latency. The evaluation also runs nightly in CI.

Measured on an RTX 4070 Ti (Windows 11), 38 tasks × 2 runs:

| | qwen2.5-coder:7b (32k) | qwen3.5:9b | target |
|---|---|---|---|
| tool-call validity | 98.9% | 98.7% | ≥ 98% |
| calls refused by policy (read before edit, protected tests) | 8.2% | 0.4% | |
| edit apply | 87.4% | 98.2% | ≥ 95% |
| task pass | 80.3% | 94.7% | ≥ 60% |
| avg steps / time per task | 5.9 / 7.9 s | 6.3 / 11.8 s | |

On the same 38 tasks before these fixes, qwen2.5-coder:7b passed 60.5% (edit apply 77.8%). qwen3.5:9b meets all three targets of the plan; with qwen2.5-coder:7b edit apply is still below 95% (most failed edits are a `search` the model got wrong), and it fails `go-chunk` (it decides the loop is already correct), `js-split-validators`, `js-extract-tax`, `js-fix-failing-tests`, `py-fix-failing-tests`, `git-fix-uncommitted` and `js-validate-email` (a too-weak email check) in both runs. Measured before the last change (stopping replies that repeat one line), which only makes such steps fail sooner.

Autocomplete latency (`eval.js fim`, 40 completions, before the editor's 250 ms debounce): qwen2.5-coder:1.5b p50 60 ms / p90 121 ms on the GPU and p50 325 ms / p90 1.07 s on the CPU only; qwen2.5-coder:7b p50 156 ms / p90 780 ms on the GPU. The plan's goal was p50 under 500 ms on a GPU and about 1 s on a CPU with a 1.5B model.

**Fine-tuning.** `scripts/finetune` writes merged safetensors that `ollama create -q q4_K_M` imports (no llama.cpp build), and `eval.js export --exclude` keeps evaluation tasks out of the dataset.

**Releases.** Pushing a `v*` tag builds the .vsix and publishes it to the Marketplace and Open VSX once their tokens are set as repository secrets.

## 0.4.1

- "Run everything" mode (`/yolo`, `localAgent.autoRunCommands`): edits and terminal commands without asking; dangerous commands stay blocked. The chosen mode now carries over to new conversations.
- `dotnet run`, `npm run dev` and other servers are no longer refused: they start in the background, and the agent can call them with `curl`.
- When the model asks for a tool that is hidden for the current task (e.g. `start_process`), it gets it instead of an error loop.
- Generated projects: `run_command` lists the files a generator created, a missing path suggests the existing file with the same name, and a second `Program.cs` (or `package.json`, ...) in the same project is refused. This fixes runs that created `src/TodoApi/Program.cs` next to the template's and never built again.
- A todo that only runs one command (e.g. "Run `dotnet new webapi -n TodoApi`") is completed as soon as that command succeeds when more todos follow, and a todo that keeps making progress without failures gets more steps.
- .NET: a project inside another project's folder (e.g. `TodoApi/TodoApi.Tests`) is diagnosed on failing builds with the fix (move it, or `<Compile Remove>`); before, the outer project failed with "Xunit could not be found" and the agent kept editing the test project. New NuGet and npm packages must come from `dotnet add package` / `npm install` instead of hand-edited versions (a guessed EF Core 9 in a .NET 10 project). Files named only `.sln` are refused.
- `run_command` with `cwd` and paths written from the workspace root (`cwd: TodoApi`, `dotnet build TodoApi/TodoApi.csproj`) runs from the root instead of failing with "file not found".
- `start_process` reports the address the server listens on, not the first URL in its log.
- Command output is cleaned of terminal control sequences and progress redraws (the MSBuild terminal logger is turned off).
- README: context size and hardware guide.

## 0.4.0

Stages 11–14 of the plan: stronger tools, web, MCP, memory. Every optional tool is offered only when a task needs it, so small models still see ≤ 10 tools per step.

- Refactoring by code: `rename_symbol` (language server in VS Code, tree-sitter elsewhere) renames definitions, imports and calls across files in one reviewed step; `find_references`, `find_definition`, `read_symbol`; `move_file`/`delete_file`; read-only `git_diff`/`git_log`/`git_blame`.
- `start_process` runs a server in the background until it is ready, so it can be tried with `curl`; everything is stopped when the task ends.
- Test output parsing for vitest/jest, node:test, pytest, unittest, dotnet test and cargo test: failures first, as `file:line name: message`.
- Rules hooks: `after-edit:` (e.g. a formatter) and `before-done:`.
- Web search (off by default): SearXNG, Brave, Tavily or DuckDuckGo; `fetch_url` with private-network blocking and relevant-part extraction for long pages; `@web`; `@docs:<package>` for the installed package's README.
- MCP: servers from `.agent/mcp.json`, `.vscode/mcp.json` or settings (stdio and HTTP). Tools are picked per task, calls are approved unless read-only, resources are `@mcp:` mentions, prompts are `/` commands, `/mcp` shows status. `cli --mcp-server` serves Agent Lolo's own tools to other agents.
- Memory: "remember …" saves facts to `.agent/memory.md` (reviewed), which every later conversation sees; `/memory`.
- Custom `/` commands from `.agent/commands/*.md`.
- Pasted screenshots for vision models (qwen3.5).
- Semantic code search with a local embedding model (`localAgent.embeddingModel`).
- An explore helper for vague tasks in large repositories.
- `move_file` updates the imports itself: relative `require`/`import`/`export ... from` in JS/TS (including the moved file's own) and module imports in Python.
- Fixes: a complete rewrite with a comment such as `// Existing tests...` was treated as a lazy placeholder and rejected as a syntax error; syntax-error feedback now shows the would-be code around the error, and replies cut short by an unescaped quote get an explanation the model can act on; empty files read as "empty" instead of showing only the edit hint (models copied the hint into `search`), and `create_file` refuses empty content; questions that get stuck are answered with what was found.
- Eval: 14 tasks (JS, Python, C#, Go), including renames, moves, a large file and a multi-file extraction. `scripts/finetune` prepares a LoRA fine-tune from successful runs.

## 0.3.1

- README: screenshots, quick start, mode and model guides.
- Chat: the composer toolbar no longer overflows in narrow panels.

## 0.3.0 (preview)

First public preview.

- Agent chat with conversation memory, conversation history and a context usage indicator.
- Modes: Ask before edits, Edit automatically, Plan mode (with "Run this plan"), Read-only.
- Permission prompts with diffs for edits and commands; session-wide "don't ask again".
- Checkpoints in a shadow git repository, restorable per run.
- Guard rails for small models: JSON-schema tool calls, fuzzy edit matching, tree-sitter syntax guard, automatic build/type checks, server/watch command blocking, command timeouts.
- Ctrl+I inline edit, fill-in-the-middle autocomplete, @-mentions, tree-sitter repository map.
- Built-in profiles for qwen2.5-coder, qwen3-coder and qwen3.5; first-run check for Ollama and the model.

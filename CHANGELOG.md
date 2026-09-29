# Changelog

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

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local-first AI coding agent as a VS Code extension, built for small local models (7B–14B, primarily `qwen2.5-coder-32k`, i.e. qwen2.5-coder:7b with `num_ctx` 32768) via Ollama or OpenAI-compatible servers. The guiding principle (see `plan.md`, written in Uzbek, which is the original spec): **quality comes from orchestration, not the model.** Code gathers context, constrains output with JSON schemas, validates, and verifies. Prefer fixing agent failures in orchestration over prompt tweaks, and measure with the eval.

## Commands

```bash
npm run build            # esbuild (extension, cli, eval, smoke test) + vite (webview) → dist/
npm run typecheck        # tsc for extension/core + separate tsc for the webview (DOM/JSX config)
npm test                 # vitest unit tests (test/**/*.test.ts only)
npx vitest run test/fuzzyApply.test.ts        # single file
npx vitest run -t "reports parse errors"       # single test by name
npm run test:vscode      # smoke test inside a real VS Code; needs VSCODE_BIN=<electron binary>; SMOKE_E2E=1 adds a chat run with the real model (approval card → Yes → file changed → follow-up)
                         #   here: VSCODE_BIN=/snap/code/current/usr/share/code/code (the `code` CLI wrapper detaches and hides output)
node dist/cli.js --root <dir> [-y] [--mode agent|ask|plan] "task"   # headless agent (edits auto-approved, checkpoint first)
node dist/cli.js --root <dir> --chat [-y]   # multi-turn REPL (stdin lines = messages); best way to test conversation behavior
node dist/cli.js --root <dir> --checkpoints | --restore <id>
node dist/eval.js run [--filter id] [--runs n] [--model m]          # eval → eval/results/<ts>/ (compares with previous run)
node dist/eval.js export --out dataset.jsonl eval/results/<ts>      # passing trajectories → fine-tune samples
npm run package          # production build + vsce package
```

Requires Ollama at `localhost:11434` with `qwen2.5-coder-32k:latest` for anything that calls the model (cli, eval). Unit tests don't need it. npm 11 blocks install scripts: only esbuild is allowlisted (`allowScripts` in package.json).

## Architecture

**The core never imports `vscode`.** Everything the agent needs from its environment goes through `Host` (`src/host/types.ts`), which has two implementations: `VsCodeHost` (WorkspaceEdit writes, inline review, LSP diagnostics, shell-integration terminal) and `NodeHost` (plain fs, used by the CLI, eval and tests). esbuild bundles `src/cli.ts` and `eval/runner.ts` without `vscode`; keep it that way.

Run flow (`src/agent/loop.ts`, `Agent.run`):
1. Checkpoint: a shadow git repo at `.agent/checkpoints` using a separate `GIT_DIR`, so the user's repo is untouched. `restore()` snapshots first and never moves HEAD back.
2. Context. The **system message** holds everything stable: prompt + tool list + `.agent/rules.md` + repo map. The **task message** holds per-run context: @-mentions, active file/selection, diagnostics, git diff stat. The history then only grows at the tail. This ordering is deliberate: it lets Ollama reuse its KV cache between steps. Don't put changing content early in the prompt.
3. Plan (`planner.ts`): schema `{goal, kind, reply, todos}`, in that order (generation order: restating in English before classifying fixes non-English messages). `kind` is chat (answered with `reply`, no tools), question (read-only; ends with the `answer` tool, never `done`) or task. `allowedKinds()` narrows the `kind` enum *without the model*: punctuation-only → chat, question words without request words → question. The plan exchange becomes the history preamble. Checkpoints are taken only once a message is a task.
   Conversation: the chat (and `cli --chat`) pass earlier turns as text (`ui/transcript.ts: conversationText`) in the task message; `pendingPlanFor()` deterministically turns a short go-ahead ("ha", "ishni boshla", "ok", "давай") after a planned turn into `RunOptions.plan`, which skips the planner. `agent/glossary.ts` appends English hints for Uzbek words.
4. Per todo: one tool call per step. The per-step JSON schema is an `anyOf` with one branch per *enabled* tool, passed as Ollama `format` (outside the prompt, so changing it doesn't break the cache). Then `ToolRegistry.check`: schema, path normalization/sandboxing, then tool-specific `check()`. Errors are phrased for the model to fix.
5. After a write: diagnostics for the changed files. On `done`: the `verify:` commands from rules, or checks inferred from project files (`context/projectChecks.ts`; detected at that moment, so projects created during the run count). Failures feed back into repair (max 3).
   `run_command` takes `cwd`, times out after 2 min (process group killed / Ctrl+C in the terminal), and refuses servers/watchers (`dotnet run` on `Sdk.Web` projects, `npm start/dev`, ...). The system prompt carries an Environment line (`context/environment.ts`: OS, date, installed SDK versions) so the model doesn't downgrade frameworks.
6. Stuck detection: repeating a call made since the last write is blocked (catches A-B-A-B loops), and any write attempt re-allows reads. On 3 repeats or 4 consecutive failures, `onStuck` first runs the project checks: if the todo changed files and they pass, the todo is complete (small models keep "polishing" finished work). Two no-op writes in a row do the same. Otherwise ask the user (interactive hosts) or fail the todo. Ollama generation errors (e.g. "token repeat limit") are retried at a higher temperature. `ask_user` is not offered to the model at all: 7B models used it instead of working.
7. History compaction (`compaction.ts`) replaces old observations with one-line summaries, but only when over budget, again to keep the prefix stable.

Edit engine (`src/edit/`), where most of the 7B-model reliability lives:
- Format policy (`formats.ts`, `editToolFor`): files ≤ `wholeFileMaxLines` → `rewrite_file` recommended; larger → `edit` (search/replace); after 2 failed edits on a file → `edit_lines` with a numbered view. Hard constraints only: `rewrite_file` is rejected on large files, and `edit_lines` requires line-range mode. `edit` is always allowed (rejecting it measurably hurt the eval). `read_file` shows line numbers only in line-range mode (models copy numbers into `search` otherwise).
- `fuzzyApply`: exact → whitespace-normalized → fuzzy (char-weighted ≥ 0.85, with an ambiguity margin), re-indenting the replacement. It refuses a stale `search` whose `replace` is already present (fuzzy would otherwise match the already-edited line). `all: true` replaces every exact occurrence.
- `mergeLazyRewrite` fills `// ... existing code ...` placeholders from the original. `write()` in `tools/fileTools.ts` then preserves EOL, the trailing newline and blank-line spacing, rejects no-op writes, and runs the **syntax guard** (tree-sitter parse errors introduced by the edit; bracket balance for languages without a grammar).
- `diffView.ts`: the inline review writes old (red) + new (green) lines into the real document, with Accept/Reject CodeLens per hunk; the `localAgent.diffPending` context key drives Tab/Esc. Pure logic is in `lineDiff.ts`.

Context (`src/context/`): `treeSitter.ts` loads the grammars from `@vscode/tree-sitter-wasm` (copied to `dist/wasm` by `esbuild.mjs`; resolved from node_modules when running from source). It compiles each query pattern separately so an unsupported pattern is skipped, not fatal, and caches by content hash. `repoMap.ts` is Aider-style: a ref→def file graph, PageRank personalized to focus files (mentions, active file, tabs) and identifiers in the task, and a binary search for the most signatures that fit the budget. `budget.ts` sets the per-section quotas.

Other entry points: `autocomplete/` (FIM: `fim.ts` holds the pure prompt/stop/overlap logic; a whitespace-only cursor line sets the base indent), `inline/` (Ctrl+I), `ui/` (`chatView.ts` extension side; `transcript.ts` event→items reducer and conversation text, shared with the CLI; `protocol.ts` shared types; `webview/` React app built by Vite with its own tsconfig; history in `workspaceState`).

Permissions: during a chat run `VsCodeHost.approvalHandler` turns edits and non-allowlisted commands into approval cards (unified diff from `lineDiff.ts: unifiedDiff`); "always" answers are session state in `ChatViewProvider` (auto-accept edits, allowed command prefixes). Without a chat (commands, Ctrl+I) edits go to the inline editor review instead.

Model profiles (`providers/modelProfiles.ts`): agent code reads only the profile (ctx, editFormat, wholeFileMaxLines, FIM tokens, toolMode, ...). A new model should need only a profile. `toolMode`: `schema` (constrained decoding; the default and by far the most reliable for 7B), `native` (endpoint function calling; qwen2.5-coder via Ollama emits `{"name","arguments"}` as text instead of `tool_calls`, and the parser accepts both), `xml` (tagged text for endpoints without schema support; unconstrained 7B models improvise tags, so the parser also accepts `<tool attr="...">`). History stores each action in the mode's own format (`ToolRegistry.render`), because models copy the format they see. Try modes with `--tool-mode` on the cli/eval.

## Working on the agent

- Every run writes `.agent/trajectories/<ts>.jsonl` (`llm` entries store only the new messages: `from` = index of the first changed message). Read these to diagnose failures before changing prompts or policy.
- Judge changes with `node dist/eval.js run --runs 2` (6 tasks × 2 runs ≈ 10 min). Single runs are noisy. Targets from the plan: tool-call validity ≥ 98%, edit apply ≥ 95% (no-op writes excluded), task pass ≥ 60%.
- An eval task is `eval/tasks/<id>/{task.json, repo/, check/}`. `check/` files are copied in *after* the run (hidden tests). The repo's `.agent/rules.md` verify command must succeed on a correct solution; e.g. `python3 -m unittest` exits 5 when no tests exist, so ship a visible test.
- Test fixtures and planner examples must not mirror eval tasks (an example matching the demo task inflated results once).
- Only `edit` failures (and syntax-guard rejections) count toward the line-range fallback; `recordSuccess` resets the count.

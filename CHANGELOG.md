# Changelog

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

import type { ChatMessage } from "../providers/types";

/** Pure helpers for Ctrl+I inline edit (prompt + reply parsing); tested without vscode. */

const CONTEXT_LINES = 40;

export function inlineEditMessages(opts: { path: string; language: string; before: string; selection: string; after: string; instruction: string }): ChatMessage[] {
  const clip = (s: string, fromEnd: boolean) => {
    const lines = s.split("\n");
    return (fromEnd ? lines.slice(-CONTEXT_LINES) : lines.slice(0, CONTEXT_LINES)).join("\n");
  };
  return [
    {
      role: "system",
      content:
        "You rewrite a selected block of code according to an instruction. Reply with only the new code for the selected block, " +
        "in a single ``` fenced block, with the same indentation as the original. Do not include the surrounding code. Do not explain.",
    },
    {
      role: "user",
      content:
        `File: ${opts.path} (${opts.language})\n\n` +
        `Code before the selection:\n\`\`\`\n${clip(opts.before, true)}\n\`\`\`\n\n` +
        `Selected code:\n\`\`\`\n${opts.selection}\n\`\`\`\n\n` +
        `Code after the selection:\n\`\`\`\n${clip(opts.after, false)}\n\`\`\`\n\n` +
        `Instruction: ${opts.instruction}\n\nReply with the rewritten selected code only.`,
    },
  ];
}

/** Extracts the code from the model's reply (first fenced block, else the whole reply). */
export function extractCode(reply: string): string {
  const m = /```[^\n]*\n([\s\S]*?)```/.exec(reply);
  const code = m ? m[1] : reply.replace(/^```[^\n]*\n?/, "").replace(/```\s*$/, "");
  return code.replace(/\n$/, "");
}

/** If the model dropped the selection's indentation, adds it back. */
export function matchIndent(code: string, original: string): string {
  const want = /^[ \t]*/.exec(original.split("\n").find((l) => l.trim()) ?? "")![0];
  const firstLine = code.split("\n").find((l) => l.trim()) ?? "";
  const have = /^[ \t]*/.exec(firstLine)![0];
  if (have.length >= want.length || !want) return code;
  const add = want.slice(have.length);
  return code.split("\n").map((l) => (l.trim() ? add + l : l)).join("\n");
}

import type { FimTokens } from "../providers/modelProfiles";

/** Pure FIM logic (prompt + post-processing); the VS Code provider lives in fimProvider.ts. */

export interface FimContextFile {
  path: string;
  text: string;
}

export interface FimInput {
  path: string;
  prefix: string;
  suffix: string;
  /** Related code (signatures of imported files), most relevant last. */
  context?: FimContextFile[];
}

export function buildFimPrompt(tokens: FimTokens, input: FimInput): string {
  const ctx = input.context ?? [];
  if (tokens.fileSep) {
    // Repo-level format (Qwen2.5-Coder): other files first, then the current file with the FIM hole.
    const files = ctx.map((f) => `${tokens.fileSep}${f.path}\n${f.text}\n`).join("");
    return `${files}${ctx.length ? `${tokens.fileSep}${input.path}\n` : ""}${tokens.prefix}${input.prefix}${tokens.suffix}${input.suffix}${tokens.middle}`;
  }
  const header = ctx.length ? commentBlock(input.path, ctx.map((f) => `${f.path}:\n${f.text}`).join("\n")) : "";
  return `${tokens.prefix}${header}${input.prefix}${tokens.suffix}${input.suffix}${tokens.middle}`;
}

function commentBlock(path: string, text: string): string {
  const c = /\.(py|rb|sh|ps1|ya?ml|toml)$/i.test(path) ? "#" : "//";
  return text.split("\n").map((l) => `${c} ${l}`).join("\n") + "\n";
}

/**
 * Trims a raw completion:
 * - mid-line cursor → single line;
 * - stops before a line that closes a block the completion did not open, or at a
 *   dedent below the cursor's indentation (the next declaration);
 * - drops a tail that repeats the start of the suffix.
 */
export function postprocessCompletion(raw: string, prefix: string, suffix: string): string {
  let text = raw.replace(/\r\n/g, "\n");
  if (!text.trim()) return "";
  const lineBefore = prefix.slice(prefix.lastIndexOf("\n") + 1);
  const lineAfter = suffix.split("\n")[0];

  if (lineAfter.trim()) {
    // Cursor inside a line: complete that line only.
    text = text.split("\n")[0];
  } else {
    const lines = text.split("\n");
    // Whitespace-only cursor line: its width is the indentation being completed.
    const baseIndent = lineBefore.trim() || !lineBefore ? indentWidth(lineBefore || lastNonBlank(prefix)) : indentWidth(lineBefore);
    let depth = 0;
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const d = bracketDelta(l);
      if (depth + d < 0 && i > 0) {
        // This line closes a block opened before the completion: keep the closer only if the suffix doesn't have it.
        const closer = l.trim();
        if (!suffix.trimStart().startsWith(closer[0] ?? "")) out.push(l);
        break;
      }
      // Dedent below the cursor's indentation (outside any block the completion opened) = next declaration.
      if (i > 0 && l.trim() && depth <= 0 && indentWidth(l) < baseIndent) break;
      depth += d;
      out.push(l);
      if (i > 0 && !l.trim() && !lines[i - 1]?.trim()) break; // two blank lines: stop
    }
    text = out.join("\n");
  }

  text = trimSuffixOverlap(text, suffix);
  return text.replace(/[ \t]+$/gm, "").replace(/\n+$/, "");
}

export function trimSuffixOverlap(text: string, suffix: string): string {
  const s = suffix.replace(/^[ \t]*\n?/, "");
  // Whole trailing lines equal to the suffix's first lines.
  const tLines = text.split("\n");
  const sLines = s.split("\n");
  // Indentation must match too: a bare "}" in the suffix closes a different block than "  }".
  for (let k = Math.min(tLines.length - 1, sLines.length); k > 0; k--) {
    const tail = tLines.slice(-k).map((l) => l.trimEnd());
    const head = sLines.slice(0, k).map((l) => l.trimEnd());
    if (tail.join("").trim() && tail.join("\n") === head.join("\n")) return tLines.slice(0, -k).join("\n");
  }
  // Character overlap at the end (e.g. completion ends with ");" and suffix starts with ");").
  const first = suffix.split("\n")[0];
  for (let k = Math.min(first.length, text.length); k > 0; k--) {
    if (text.endsWith(first.slice(0, k)) && first.slice(0, k).trim()) return text.slice(0, -k);
  }
  return text;
}

function bracketDelta(line: string): number {
  let d = 0;
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "/" && line[i + 1] === "/") break;
    else if ("{([".includes(c)) d++;
    else if ("})]".includes(c)) d--;
  }
  return d;
}

function indentWidth(line: string): number {
  const ws = /^[ \t]*/.exec(line)![0];
  return ws.replace(/\t/g, "    ").length;
}

function lastNonBlank(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) return lines[i];
  return "";
}

/** Reuses the previous completion while the user types what it suggested. */
export class CompletionCache {
  private last?: { prefix: string; suffix: string; text: string };

  get(prefix: string, suffix: string): string | undefined {
    const l = this.last;
    if (!l || suffix !== l.suffix || !prefix.startsWith(l.prefix)) return undefined;
    const typed = prefix.slice(l.prefix.length);
    if (!l.text.startsWith(typed)) return undefined;
    const rest = l.text.slice(typed.length);
    return rest || undefined;
  }

  set(prefix: string, suffix: string, text: string) {
    this.last = { prefix, suffix, text };
  }
}

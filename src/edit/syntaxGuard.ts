import { syntaxError } from "../context/treeSitter";

/**
 * Cheap structural check for brace languages until tree-sitter lands: an edit that
 * takes a file from balanced to unbalanced brackets is almost always a broken
 * splice (7B models often drop or duplicate a closing brace).
 */
const BRACE_LANG = /\.(ts|tsx|js|jsx|mjs|cjs|cs|java|kt|go|rs|c|h|cpp|hpp|cc|swift|php|dart|scala|json|jsonc)$/i;
const PAIRS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

export interface Imbalance {
  line: number;
  message: string;
}

/** First bracket problem in `text`, skipping strings and comments; undefined when balanced. */
export function findImbalance(text: string): Imbalance | undefined {
  const stack: { ch: string; line: number }[] = [];
  let line = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "\n") {
      line++;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      i--;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (; i < stop; i++) if (text[i] === "\n") line++;
      i--;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      // Verbatim/raw strings (C# @"..", Rust r"..") are close enough to plain ones for balance purposes.
      for (i++; i < text.length && text[i] !== c; i++) {
        if (text[i] === "\\") i++;
        else if (text[i] === "\n") {
          line++;
          if (c !== "`") break; // unterminated single-line string: stop scanning it
        }
      }
      continue;
    }
    if (c === "(" || c === "[" || c === "{") stack.push({ ch: c, line });
    else if (c in PAIRS) {
      const top = stack.pop();
      if (!top) return { line, message: `unexpected '${c}' at line ${line}` };
      if (top.ch !== PAIRS[c]) return { line, message: `'${top.ch}' opened at line ${top.line} is closed by '${c}' at line ${line}` };
    }
  }
  const open = stack.pop();
  return open ? { line: open.line, message: `'${open.ch}' opened at line ${open.line} is never closed` } : undefined;
}

/**
 * Error text when an edit breaks a file that parsed cleanly before; else undefined.
 * Uses tree-sitter where a grammar exists, bracket balance otherwise.
 */
export async function checkEditSyntax(path: string, before: string | undefined, after: string): Promise<string | undefined> {
  const afterErr = await syntaxError(path, after);
  if (afterErr === null) return checkEditStructure(path, before, after); // no grammar
  if (!afterErr) return undefined;
  if (before !== undefined && (await syntaxError(path, before))) return undefined; // was already broken
  return `This change would introduce a syntax error (${afterErr}). The file was NOT changed. Re-read the file and make an edit that keeps the code valid.`;
}

/** Error text when the edit breaks bracket balance of a previously balanced file; else undefined. */
export function checkEditStructure(path: string, before: string | undefined, after: string): string | undefined {
  if (!BRACE_LANG.test(path)) return undefined;
  if (before !== undefined && findImbalance(before)) return undefined; // was already unbalanced (or our lexer can't read it)
  const problem = findImbalance(after);
  return problem ? `This change would leave the brackets unbalanced: ${problem.message}. The file was NOT changed. Re-read the file and make an edit that keeps every block complete.` : undefined;
}

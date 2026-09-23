import { detectEol, fromLf, leadingWs, levenshtein, normalizeWs, numberLines, toLf } from "./text";

export const FUZZY_THRESHOLD = 0.85;
/** A second non-overlapping window this close to the best one makes a fuzzy match ambiguous. */
const AMBIGUITY_MARGIN = 0.05;

export type ApplyResult =
  | { ok: true; content: string; strategy: "exact" | "whitespace" | "fuzzy"; score: number; startLine: number }
  | { ok: false; reason: string; closest?: { startLine: number; text: string; score: number } };

/**
 * Replaces `search` with `replace` in `content`, trying exact → whitespace-normalized
 * → fuzzy (line-wise similarity ≥ 0.85). Non-exact matches re-indent `replace` to the
 * indentation actually found in the file.
 */
export function fuzzyApply(content: string, search: string, replace: string, opts: { all?: boolean } = {}): ApplyResult {
  const eol = detectEol(content);
  const text = toLf(content);
  search = trimBlankEdges(toLf(search));
  replace = toLf(replace);
  if (!search.trim()) return { ok: false, reason: "`search` is empty. Quote the exact lines to replace." };
  if (opts.all && !text.includes(search)) return { ok: false, reason: "With all=true, `search` must match the file exactly; it was not found." };

  // 1. exact
  const first = text.indexOf(search);
  if (first >= 0 && opts.all) {
    const content = text.split(search).join(replace);
    return { ok: true, content: fromLf(content, eol), strategy: "exact", score: 1, startLine: lineOf(text, first) };
  }
  if (first >= 0) {
    if (text.indexOf(search, first + 1) >= 0) {
      return { ok: false, reason: "`search` matches more than one place. Include more surrounding lines to make it unique, or set all=true to replace every occurrence." };
    }
    const content = text.slice(0, first) + trimBlankEdges(replace) + text.slice(first + search.length);
    return { ok: true, content: fromLf(content, eol), strategy: "exact", score: 1, startLine: lineOf(text, first) };
  }

  // A stale `search` whose replacement is already in the file: the change was made
  // earlier. Fuzzy-matching it would hit the already-edited lines.
  const replaceTrimmed = trimBlankEdges(replace);
  if (replaceTrimmed.trim() && (text.includes(replaceTrimmed) || normalizeWs(text).includes(normalizeWs(replaceTrimmed)))) {
    return { ok: false, reason: "The file already contains `replace` and not `search`: this change is already applied. Re-read the file before editing again." };
  }

  const lines = text.split("\n");
  const searchLines = search.split("\n");
  const n = searchLines.length;

  // 2. whitespace-normalized
  const normSearch = searchLines.map(normalizeWs);
  const normLines = lines.map(normalizeWs);
  const wsHits: number[] = [];
  for (let i = 0; i + n <= lines.length; i++) {
    if (normSearch.every((s, k) => s === normLines[i + k])) wsHits.push(i);
  }
  if (wsHits.length > 1) {
    return { ok: false, reason: "`search` matches more than one place (ignoring whitespace). Include more surrounding lines." };
  }
  if (wsHits.length === 1) {
    return splice(lines, wsHits[0], n, searchLines, replace, eol, "whitespace", 1);
  }

  // 3. fuzzy: best window of the same line count, scored by character edit
  // distance over the whole window so short lines like `}` don't inflate it.
  const searchChars = normSearch.reduce((a, l) => a + l.length, 0);
  const scores: number[] = [];
  let best = { start: -1, score: 0 };
  for (let i = 0; i + n <= lines.length; i++) {
    let dist = 0;
    let chars = 0;
    for (let k = 0; k < n; k++) {
      dist += levenshtein(normSearch[k], normLines[i + k]);
      chars += Math.max(normSearch[k].length, normLines[i + k].length);
    }
    const score = chars === 0 ? 0 : 1 - dist / Math.max(chars, searchChars);
    scores.push(score);
    if (score > best.score) best = { start: i, score };
  }
  if (best.start >= 0 && best.score >= FUZZY_THRESHOLD) {
    const rival = scores.some((s, i) => Math.abs(i - best.start) >= n && best.score - s < AMBIGUITY_MARGIN);
    if (rival) {
      return { ok: false, reason: "`search` is similar to more than one place in the file. Copy the lines exactly and include more context." };
    }
    return splice(lines, best.start, n, searchLines, replace, eol, "fuzzy", best.score);
  }

  const closest =
    best.start >= 0
      ? { startLine: best.start + 1, text: numberLines(lines.slice(best.start, best.start + n), best.start + 1), score: round(best.score) }
      : undefined;
  return {
    ok: false,
    reason: "`search` was not found in the file. Copy the lines exactly as they appear in the file.",
    closest,
  };
}

function splice(
  lines: string[],
  start: number,
  n: number,
  searchLines: string[],
  replace: string,
  eol: "\r\n" | "\n",
  strategy: "whitespace" | "fuzzy",
  score: number,
): ApplyResult {
  const reindented = reindent(replace, searchLines, lines.slice(start, start + n));
  const out = [...lines.slice(0, start), ...reindented, ...lines.slice(start + n)];
  return { ok: true, content: fromLf(out.join("\n"), eol), strategy, score: round(score), startLine: start + 1 };
}

/**
 * Shifts `replace` by the indentation difference between what the model quoted and
 * what the file actually has (first non-blank line of each).
 */
export function reindent(replace: string, searchLines: string[], actualLines: string[]): string[] {
  const replaceLines = trimBlankEdges(replace).split("\n");
  if (!replace.trim()) return [];
  const k = searchLines.findIndex((l) => l.trim());
  if (k < 0) return replaceLines;
  const quoted = leadingWs(searchLines[k]);
  const actual = leadingWs(actualLines[k] ?? "");
  if (quoted === actual) return replaceLines;
  if (actual.startsWith(quoted)) {
    // File is indented deeper than quoted: add the difference everywhere.
    const add = actual.slice(quoted.length);
    return replaceLines.map((l) => (l.trim() ? add + l : l));
  }
  if (quoted.startsWith(actual)) {
    // File is indented shallower: strip the difference where present.
    const cut = quoted.slice(actual.length);
    return replaceLines.map((l) => (l.startsWith(cut) ? l.slice(cut.length) : l));
  }
  // Different indent characters (tabs vs spaces): swap the quoted prefix.
  return replaceLines.map((l) => (l.startsWith(quoted) ? actual + l.slice(quoted.length) : l));
}

function trimBlankEdges(s: string): string {
  return s.replace(/^(?:[ \t]*\n)+/, "").replace(/(?:\n[ \t]*)+$/, "");
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function round(x: number) {
  return Math.round(x * 100) / 100;
}

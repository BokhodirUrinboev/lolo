/** Line/EOL helpers shared by the edit engine. Internally everything is LF. */

export function detectEol(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function fromLf(text: string, eol: "\r\n" | "\n"): string {
  return eol === "\n" ? text : text.replace(/\n/g, "\r\n");
}

export function leadingWs(line: string): string {
  return /^[ \t]*/.exec(line)![0];
}

export function normalizeWs(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

export function numberLines(lines: string[], start = 1): string {
  const width = String(start + lines.length - 1).length;
  return lines.map((l, i) => `${String(start + i).padStart(width)}| ${l}`).join("\n");
}

/** Levenshtein similarity in [0,1]. */
export function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** Longest run of consecutive blank lines. */
export function maxBlankRun(text: string): number {
  let max = 0;
  let run = 0;
  for (const l of toLf(text).split("\n")) {
    run = l.trim() ? 0 : run + 1;
    max = Math.max(max, run);
  }
  return max;
}

/** Collapses runs of blank lines longer than `maxRun` (small models under JSON constraints emit "\n\n\n..."). */
export function collapseBlankRuns(text: string, maxRun: number): string {
  const out: string[] = [];
  let run = 0;
  for (const l of text.split("\n")) {
    run = l.trim() ? 0 : run + 1;
    if (run <= maxRun) out.push(l);
  }
  return out.join("\n");
}

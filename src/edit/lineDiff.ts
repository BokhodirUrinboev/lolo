/** Line-level diff for the inline diff view. Pure (no vscode), so it is unit-tested. */

export interface Hunk {
  /** 0-based index in the old lines where the hunk starts. */
  oldStart: number;
  removed: string[];
  added: string[];
}

const MAX_DP_CELLS = 4_000_000;

/** Hunks turning `oldLines` into `newLines`. Common prefix/suffix are trimmed before the LCS. */
export function diffLines(oldLines: string[], newLines: string[]): Hunk[] {
  let pre = 0;
  while (pre < oldLines.length && pre < newLines.length && oldLines[pre] === newLines[pre]) pre++;
  let suf = 0;
  while (suf < oldLines.length - pre && suf < newLines.length - pre && oldLines[oldLines.length - 1 - suf] === newLines[newLines.length - 1 - suf]) suf++;
  const a = oldLines.slice(pre, oldLines.length - suf);
  const b = newLines.slice(pre, newLines.length - suf);
  if (!a.length && !b.length) return [];
  if (!a.length || !b.length || a.length * b.length > MAX_DP_CELLS) return [{ oldStart: pre, removed: a, added: b }];

  // LCS table (suffix form) over the changed middle.
  const n = a.length;
  const m = b.length;
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = a[i] === b[j] ? dp[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
  }
  const hunks: Hunk[] = [];
  let cur: Hunk | undefined;
  let i = 0;
  let j = 0;
  const flush = () => {
    if (cur) hunks.push(cur);
    cur = undefined;
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i * (m + 1) + j + 1] >= dp[(i + 1) * (m + 1) + j])) {
      cur ??= { oldStart: pre + i, removed: [], added: [] };
      cur.added.push(b[j++]);
    } else {
      cur ??= { oldStart: pre + i, removed: [], added: [] };
      cur.removed.push(a[i++]);
    }
  }
  flush();
  return hunks;
}

export interface MergedHunk {
  id: number;
  /** Line in the merged document where the removed lines start (added lines follow them). */
  start: number;
  removed: number;
  added: number;
}

/**
 * Builds the pending-review document: unchanged lines, and for each hunk its removed
 * lines followed by its added lines. Accepting a hunk deletes its removed lines;
 * rejecting deletes its added lines.
 */
export function mergeForReview(oldLines: string[], hunks: Hunk[]): { lines: string[]; hunks: MergedHunk[] } {
  const lines: string[] = [];
  const merged: MergedHunk[] = [];
  let k = 0;
  hunks.forEach((h, id) => {
    while (k < h.oldStart) lines.push(oldLines[k++]);
    merged.push({ id, start: lines.length, removed: h.removed.length, added: h.added.length });
    lines.push(...h.removed, ...h.added);
    k += h.removed.length;
  });
  while (k < oldLines.length) lines.push(oldLines[k++]);
  return { lines, hunks: merged };
}

/**
 * Unified diff with `context` lines around each hunk (hunks closer than 2×context
 * are merged), for approval cards. New files diff against an empty file.
 */
export function unifiedDiff(oldText: string, newText: string, context = 3): string {
  const a = oldText === "" ? [] : oldText.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const b = newText.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const hunks = diffLines(a, b);
  if (!hunks.length) return "";
  // Group hunks whose context would overlap.
  const groups: Hunk[][] = [];
  for (const h of hunks) {
    const g = groups[groups.length - 1];
    const prev = g?.[g.length - 1];
    if (prev && h.oldStart - (prev.oldStart + prev.removed.length) <= 2 * context) g.push(h);
    else groups.push([h]);
  }
  const out: string[] = [];
  let shift = 0; // new-file line offset accumulated from earlier groups
  for (const g of groups) {
    const first = g[0];
    const last = g[g.length - 1];
    const from = Math.max(0, first.oldStart - context);
    const to = Math.min(a.length, last.oldStart + last.removed.length + context);
    const body: string[] = [];
    let k = from;
    let added = 0;
    let removed = 0;
    for (const h of g) {
      while (k < h.oldStart) body.push(` ${a[k++]}`);
      for (const l of h.removed) body.push(`-${l}`);
      for (const l of h.added) body.push(`+${l}`);
      k += h.removed.length;
      added += h.added.length;
      removed += h.removed.length;
    }
    while (k < to) body.push(` ${a[k++]}`);
    const oldLen = to - from;
    const newLen = oldLen - removed + added;
    out.push(`@@ -${oldLen ? from + 1 : 0},${oldLen} +${newLen ? from + 1 + shift : 0},${newLen} @@`, ...body);
    shift += added - removed;
  }
  return out.join("\n");
}

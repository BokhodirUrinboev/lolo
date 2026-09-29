// JSON has no `\s`, `\d`, `\w` escapes, so under schema-constrained decoding a model copying a regex
// can't write them as it would in code: `[^\s@]` came out as `[^` + line break + `@]`, as `[^` + line
// break + `\s@]`, or as `[^\ @]`, and `/^\+?[0-9]/` as `/^` + line break + `\+?[0-9]/`. The code it
// copies is known (files read in this run), so broken copies of known lines are restored.

const GLUES = ["", "\\s", "\\d", "\\w", "\\S", "\\D", "\\W", "\\b"];

/** `text` with broken copies of `known` lines restored; `fixed` counts them. */
export function restoreCopiedEscapes(text: string, known: Iterable<string>): { text: string; fixed: number } {
  const lines = new Set<string>();
  for (const l of known) if (l.trim().length >= 8) lines.add(l.trim());
  let fixed = 0;

  // `\s` written as `\ `.
  let out = text;
  for (const k of lines) {
    if (!k.includes("\\s")) continue;
    const broken = k.replace(/\\s/g, "\\ ");
    if (out.includes(broken)) {
      out = out.split(broken).join(k);
      fixed++;
    }
  }

  // A line split in the middle: the pieces after the first start without indentation and, joined
  // (with the escape that was lost, if any), make exactly a known line.
  const src = out.split("\n");
  const res: string[] = [];
  for (let i = 0; i < src.length; i++) {
    const head = src[i].trim();
    const joined = head.length >= 3 && !lines.has(head) && i + 1 < src.length ? rejoin(head, src, i + 1, lines) : undefined;
    if (joined) {
      res.push(src[i].slice(0, src[i].length - src[i].trimStart().length) + joined.line);
      i += joined.used;
      fixed++;
    } else {
      res.push(src[i]);
    }
  }
  return { text: res.join("\n"), fixed };
}

/** A known line that `head` + the pieces `src[from..]` spell out; `used` is how many pieces. */
function rejoin(head: string, src: string[], from: number, lines: Set<string>): { line: string; used: number } | undefined {
  for (const k of lines) {
    if (!k.startsWith(head) || k === head) continue;
    let pos = head.length;
    for (let j = from; j < src.length && j < from + 6; j++) {
      const piece = src[j];
      if (!piece || /^\s/.test(piece)) break;
      const glue = GLUES.find((g) => k.startsWith(g + piece, pos));
      if (glue === undefined) break;
      pos += glue.length + piece.length;
      if (pos === k.length) return { line: k, used: j - from + 1 };
    }
  }
  return undefined;
}

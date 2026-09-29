import { truncateOutput } from "./output";

export interface TestFailure {
  name: string;
  /** Workspace-relative when it lies under `root`. */
  file?: string;
  line?: number;
  message: string;
}

const clean = (s: string) => s.replace(/\r\n/g, "\n").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const clip = (s: string, n = 200) => (s.length > n ? s.slice(0, n - 3) + "..." : s);

/** Pulls failed tests out of jest/vitest, node:test, pytest, unittest, dotnet test and cargo test output. */
export function parseTestFailures(output: string, root?: string): TestFailure[] {
  const text = clean(output);
  const found = [parseVitest, parseJest, parseNodeTest, parsePytest, parseUnittest, parseDotnet, parseCargo].map((p) => p(text)).find((r) => r.length);
  return (found ?? []).map((f) => ({ ...f, file: f.file && relativize(f.file, root) }));
}

function relativize(file: string, root?: string): string {
  const f = file.replace(/\\/g, "/");
  const r = root?.replace(/\\/g, "/").replace(/\/$/, "");
  return r && f.startsWith(r + "/") ? f.slice(r.length + 1) : f;
}

function dedupe(list: TestFailure[]): TestFailure[] {
  const seen = new Set<string>();
  return list.filter((f) => !seen.has(f.name) && !!seen.add(f.name));
}

function parseVitest(text: string): TestFailure[] {
  const out: TestFailure[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const h = /^\s*(?:FAIL|×)\s+(\S+\.[cm]?[jt]sx?)\s+>\s+(.+?)(?:\s+\d+ms)?$/.exec(lines[i]);
    if (!h) continue;
    let message = "";
    let file = h[1];
    let line: number | undefined;
    for (let j = i + 1; j < lines.length && j < i + 25 && !/^\s*(?:FAIL|×)\s/.test(lines[j]); j++) {
      const m = /^\s*(?:❯|>)\s+(\S+\.[cm]?[jt]sx?):(\d+):\d+/.exec(lines[j]);
      if (m && !line) [file, line] = [m[1], Number(m[2])];
      if (!message && /(Error|expected)/.test(lines[j]) && !/^\s*(?:❯|>)/.test(lines[j])) message = lines[j].trim();
    }
    out.push({ name: h[2], file, line, message });
  }
  return dedupe(out);
}

function parseJest(text: string): TestFailure[] {
  const out: TestFailure[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const h = /^\s*● (.+?)\s*$/.exec(lines[i]);
    if (!h || /^(Console|Test suite failed to run)/.test(h[1])) continue;
    let message = "";
    let file: string | undefined;
    let line: number | undefined;
    for (let j = i + 1; j < lines.length && j < i + 40 && !/^\s*● /.test(lines[j]); j++) {
      if (!message && lines[j].trim()) message = lines[j].trim();
      const m = /at .*?\(?([^\s()]+):(\d+):\d+\)?\s*$/.exec(lines[j]);
      if (m && !file && !m[1].includes("node_modules")) [file, line] = [m[1], Number(m[2])];
    }
    out.push({ name: h[1], file, line, message });
  }
  return dedupe(out);
}

function parseNodeTest(text: string): TestFailure[] {
  const start = text.indexOf("✖ failing tests:");
  if (start < 0) return [];
  const lines = text.slice(start).split("\n").slice(1);
  const out: TestFailure[] = [];
  let at: { file: string; line: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const t = /^test at (.+?):(\d+):\d+$/.exec(lines[i]);
    if (t) {
      at = { file: t[1], line: Number(t[2]) };
      continue;
    }
    const h = /^✖ (.+?)(?: \([\d.]+ms\))?$/.exec(lines[i]);
    if (!h) continue;
    const body: string[] = [];
    for (i++; i < lines.length && !/^(?:✖ |test at )/.test(lines[i]); i++) body.push(lines[i]);
    i--;
    const first = body.findIndex((l) => l.trim());
    let message = first >= 0 ? body[first].trim() : "";
    // "Expected values to be strictly equal:" alone says nothing; the next line has the values.
    if (message.endsWith(":")) message += " " + (body.slice(first + 1).find((l) => l.trim())?.trim() ?? "");
    const loc = body.map((l) => /\(?([^\s()]+):(\d+):\d+\)?\s*$/.exec(l)).find((m) => m && !m[1].startsWith("node:") && /\bat\b/.test(m.input));
    out.push({ name: h[1], file: loc?.[1] ?? at?.file, line: loc ? Number(loc[2]) : at?.line, message });
    at = undefined;
  }
  return out;
}

function parsePytest(text: string): TestFailure[] {
  const out: TestFailure[] = [];
  const lines = text.split("\n");
  const heads = lines.map((l, i) => ({ m: /^_{2,} (.+?) _{2,}$/.exec(l), i })).filter((h) => h.m);
  for (let k = 0; k < heads.length; k++) {
    const block = lines.slice(heads[k].i + 1, heads[k + 1]?.i ?? lines.length);
    const loc = [...block].reverse().map((l) => /^(\S+\.py):(\d+): /.exec(l)).find(Boolean);
    const err = block.find((l) => /^E\s+\S/.test(l));
    if (loc || err) out.push({ name: heads[k].m![1], file: loc?.[1], line: loc ? Number(loc[2]) : undefined, message: err?.replace(/^E\s+/, "").trim() ?? "" });
  }
  if (out.length) return dedupe(out);
  for (const l of lines) {
    const m = /^(?:FAILED|ERROR) (\S+?)::(\S+?)(?: - (.*))?$/.exec(l);
    if (m) out.push({ name: m[2], file: m[1], message: m[3] ?? "" });
  }
  return dedupe(out);
}

function parseUnittest(text: string): TestFailure[] {
  const out: TestFailure[] = [];
  for (const block of text.split(/^={60,}$/m).slice(1)) {
    const h = /^\s*(FAIL|ERROR): (\S+) \((.+)\)/.exec(block);
    if (!h) continue;
    const body = block.split(/\n-{60,}\n(?:Ran \d+ test|$)/)[0].split(/\n-{60,}\n/).slice(1).join("\n");
    const frames = [...body.matchAll(/File "([^"]+)", line (\d+)/g)].filter((f) => !/[\\/]lib[\\/]python|unittest/.test(f[1]));
    const frame = frames[frames.length - 1];
    const lastLine = body.trim().split("\n").filter((l) => l.trim()).pop() ?? "";
    out.push({ name: h[2], file: frame?.[1], line: frame ? Number(frame[2]) : undefined, message: lastLine.trim() });
  }
  return out;
}

function parseDotnet(text: string): TestFailure[] {
  const out: TestFailure[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const h = /^\s*(?:Failed|X)\s+(\S+)(?:\s+\[[^\]]*\])?\s*$/.exec(lines[i]);
    if (!h) continue;
    const msg: string[] = [];
    let file: string | undefined;
    let line: number | undefined;
    let mode: "none" | "msg" | "stack" = "none";
    for (let j = i + 1; j < lines.length && !/^\s*(?:Failed|X|Passed)\s+\S+/.test(lines[j]); j++) {
      const l = lines[j];
      if (/^\s*Error Message:/.test(l)) mode = "msg";
      else if (/^\s*Stack Trace:/.test(l)) mode = "stack";
      else if (mode === "msg" && l.trim() && msg.length < 3) msg.push(l.trim());
      else if (mode === "stack" && !file) {
        const m = /in (.+?):line (\d+)/.exec(l);
        if (m) [file, line] = [m[1], Number(m[2])];
      }
    }
    out.push({ name: h[1], file, line, message: msg.join(" ").replace(/\s+/g, " ") });
  }
  return dedupe(out);
}

function parseCargo(text: string): TestFailure[] {
  const out: TestFailure[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const h = /^---- (\S+) stdout ----$/.exec(lines[i]);
    if (!h) continue;
    for (let j = i + 1; j < lines.length && !/^---- /.test(lines[j]); j++) {
      const modern = /panicked at (\S+?):(\d+):\d+:?$/.exec(lines[j]);
      if (modern) {
        out.push({ name: h[1], file: modern[1], line: Number(modern[2]), message: lines[j + 1]?.trim() ?? "" });
        break;
      }
      const old = /panicked at '(.*)', (\S+?):(\d+):\d+/.exec(lines[j]);
      if (old) {
        out.push({ name: h[1], file: old[2], line: Number(old[3]), message: old[1] });
        break;
      }
    }
  }
  return out;
}

export function formatTestFailures(failures: TestFailure[], limit = 10): string {
  const rows = failures.slice(0, limit).map((f, i) => {
    const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ""} ` : "";
    return `${i + 1}. ${where}${f.name}${f.message ? `: ${clip(f.message)}` : ""}`;
  });
  const more = failures.length > limit ? [`... and ${failures.length - limit} more`] : [];
  return [`Failing tests (${failures.length}):`, ...rows, ...more].join("\n");
}

/**
 * Output of a failed command, shaped for the model: the parsed failure list first,
 * then a shortened log. Unrecognized output is only truncated.
 */
export function failureReport(output: string, root?: string, maxLines = 120): string {
  const failures = parseTestFailures(output, root);
  if (!failures.length) return truncateOutput(output, maxLines);
  return `${formatTestFailures(failures)}\n\nLog (shortened):\n${truncateOutput(output, Math.min(maxLines, 40))}`;
}

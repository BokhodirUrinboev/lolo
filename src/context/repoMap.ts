import { spawn } from "node:child_process";
import type { Host } from "../host/types";
import { IGNORED_DIRS } from "../tools/paths";
import { findRg } from "../tools/search";
import { estimateTokens } from "./budget";
import { fileSymbols, FileSymbols, languageFor } from "./treeSitter";

const MAX_PARSED_FILES = 1500;
const MAX_FILE_BYTES = 300_000;

/**
 * Aider-style repo map. Files are graph nodes; a reference in file A to a symbol
 * defined in file B adds an A→B edge. PageRank (personalized toward focus files)
 * ranks files, each file's rank flows to the definitions it references, and the
 * top definitions' signatures are rendered until the token budget is used.
 */
export async function buildRepoMap(host: Host, tokens: number, focus: string[] = [], task = ""): Promise<string> {
  const files = await listFiles(host);
  if (!files.length || tokens <= 0) return "";

  const focusSet = new Set(focus);
  const code = files.filter((f) => languageFor(f)).sort((a, b) => Number(focusSet.has(b)) - Number(focusSet.has(a)) || depth(a) - depth(b));
  const symbols = new Map<string, FileSymbols>();
  for (const f of code.slice(0, MAX_PARSED_FILES)) {
    let text: string;
    try {
      text = await host.readFile(f);
    } catch {
      continue;
    }
    if (text.length > MAX_FILE_BYTES) continue;
    const s = await fileSymbols(f, text);
    if (s) symbols.set(f, s);
  }

  const ranked = rankDefinitions(symbols, focusSet, identifiersIn(task));
  return render(ranked, symbols, files, tokens);
}

interface RankedDef {
  file: string;
  name: string;
  rank: number;
}

export function rankDefinitions(symbols: Map<string, FileSymbols>, focus: Set<string>, mentioned: Set<string>): RankedDef[] {
  const definers = new Map<string, string[]>();
  for (const [file, s] of symbols) {
    for (const d of new Set(s.defs.map((d) => d.name))) {
      const list = definers.get(d) ?? [];
      list.push(file);
      definers.set(d, list);
    }
  }

  // Edges: referrer → definer, weighted per identifier.
  const edges = new Map<string, Map<string, Map<string, number>>>(); // from → to → ident → weight
  for (const [from, s] of symbols) {
    for (const [ident, count] of s.refs) {
      const targets = definers.get(ident);
      if (!targets) continue;
      let mul = 1;
      if (mentioned.has(ident)) mul *= 10;
      if (ident.startsWith("_")) mul *= 0.1;
      if (targets.length > 5) mul *= 0.1; // generic names (get, run, ToString...) defined everywhere
      for (const to of targets) {
        if (to === from) continue;
        const byTo = edges.get(from) ?? new Map();
        const byIdent = byTo.get(to) ?? new Map();
        byIdent.set(ident, (byIdent.get(ident) ?? 0) + mul * Math.sqrt(count));
        byTo.set(to, byIdent);
        edges.set(from, byTo);
      }
    }
  }

  const nodes = [...symbols.keys()];
  const rank = pageRank(nodes, edges, focus);

  // Spread each file's rank over the definitions it references.
  const defRank = new Map<string, number>();
  const key = (file: string, name: string) => `${file}\0${name}`;
  for (const [from, byTo] of edges) {
    let total = 0;
    for (const byIdent of byTo.values()) for (const w of byIdent.values()) total += w;
    for (const [to, byIdent] of byTo) {
      for (const [ident, w] of byIdent) defRank.set(key(to, ident), (defRank.get(key(to, ident)) ?? 0) + ((rank.get(from) ?? 0) * w) / total);
    }
  }
  const out: RankedDef[] = [];
  for (const [file, s] of symbols) {
    const fileRank = rank.get(file) ?? 0;
    for (const name of new Set(s.defs.map((d) => d.name))) {
      // Unreferenced definitions still order by their file's rank; mentioned ones float up.
      const r = (defRank.get(key(file, name)) ?? 0) + fileRank * 0.01 + (mentioned.has(name) ? 1 : 0) + (focus.has(file) ? 0.5 : 0);
      out.push({ file, name, rank: r });
    }
  }
  return out.sort((a, b) => b.rank - a.rank);
}

export function pageRank(nodes: string[], edges: Map<string, Map<string, Map<string, number>>>, focus: Set<string>, iterations = 30, damping = 0.85): Map<string, number> {
  const n = nodes.length;
  if (!n) return new Map();
  const focusNodes = nodes.filter((x) => focus.has(x));
  const personal = new Map(nodes.map((x) => [x, focusNodes.length ? (focus.has(x) ? 1 / focusNodes.length : 0) : 1 / n]));
  const outWeight = new Map<string, number>();
  for (const [from, byTo] of edges) {
    let t = 0;
    for (const byIdent of byTo.values()) for (const w of byIdent.values()) t += w;
    outWeight.set(from, t);
  }
  let rank = new Map(nodes.map((x) => [x, 1 / n]));
  for (let it = 0; it < iterations; it++) {
    const next = new Map(nodes.map((x) => [x, 0]));
    let dangling = 0;
    for (const from of nodes) {
      const r = rank.get(from)!;
      const byTo = edges.get(from);
      const total = outWeight.get(from) ?? 0;
      if (!byTo || total === 0) {
        dangling += r;
        continue;
      }
      for (const [to, byIdent] of byTo) {
        let w = 0;
        for (const v of byIdent.values()) w += v;
        next.set(to, next.get(to)! + (damping * r * w) / total);
      }
    }
    for (const x of nodes) next.set(x, next.get(x)! + (1 - damping + damping * dangling) * personal.get(x)!);
    rank = next;
  }
  return rank;
}

function render(ranked: RankedDef[], symbols: Map<string, FileSymbols>, allFiles: string[], tokens: number): string {
  const build = (k: number) => {
    const chosen = new Map<string, Set<string>>();
    const fileOrder: string[] = [];
    for (const d of ranked.slice(0, k)) {
      if (!chosen.has(d.file)) {
        chosen.set(d.file, new Set());
        fileOrder.push(d.file);
      }
      chosen.get(d.file)!.add(d.name);
    }
    const parts: string[] = [];
    for (const f of fileOrder) {
      const names = chosen.get(f)!;
      const lines = symbols.get(f)!.defs.filter((d) => names.has(d.name)).map((d) => `${"  ".repeat(Math.min(d.depth, 3) + 1)}${d.signature}`);
      parts.push(`${f}:\n${[...new Set(lines)].join("\n")}`);
    }
    return { text: parts.join("\n"), files: new Set(fileOrder) };
  };

  // Largest number of definitions that fits (binary search).
  let lo = 0;
  let hi = ranked.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(build(mid).text) <= tokens) lo = mid;
    else hi = mid - 1;
  }
  const { text, files } = build(lo);
  let out = text;

  // Leftover budget: plain paths of other files, so the model knows they exist.
  let used = estimateTokens(out);
  const rest = allFiles.filter((f) => !files.has(f)).sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  const extra: string[] = [];
  for (const f of rest) {
    const cost = estimateTokens(f + "\n");
    if (used + cost > tokens) {
      extra.push(`[${rest.length - extra.length} more files]`);
      break;
    }
    extra.push(f);
    used += cost;
  }
  if (extra.length) out += (out ? "\n\nOther files:\n" : "") + extra.join("\n");
  return out;
}

function identifiersIn(text: string): Set<string> {
  return new Set(text.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []);
}

function depth(f: string) {
  return f.split("/").length;
}

export function listFiles(host: Host): Promise<string[]> {
  const args = ["--files", "--color=never"];
  for (const d of IGNORED_DIRS) args.push("--glob", `!${d}/`);
  return new Promise((resolve) => {
    const p = spawn(findRg(host.rgPath?.()), args, { cwd: host.root });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", () => resolve([]));
    p.on("close", () => resolve(out.split("\n").filter(Boolean).map((l) => l.replace(/\\/g, "/").replace(/^\.\//, ""))));
  });
}

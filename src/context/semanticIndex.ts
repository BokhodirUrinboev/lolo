import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { ensureAgentDir } from "../edit/agentDir";
import type { Host } from "../host/types";
import { listFiles } from "./repoMap";
import { fileSymbols, languageFor } from "./treeSitter";

/**
 * Semantic code search: code split into chunks (one per top-level definition,
 * else fixed windows), embedded with a local embedding model, cached in
 * .agent/index by content hash so only changed files are embedded again.
 */

export type Embed = (texts: string[], signal?: AbortSignal) => Promise<number[][]>;

interface Chunk {
  line: number;
  endLine: number;
  title: string;
  vec: number[];
}

interface IndexFile {
  version: number;
  model: string;
  files: Record<string, { hash: string; chunks: Chunk[] }>;
}

export interface SearchHit {
  path: string;
  line: number;
  endLine: number;
  title: string;
  score: number;
}

const VERSION = 1;
const CHUNK_LINES = 60;
const WINDOW = 40;
const MAX_FILE_BYTES = 200_000;
const MAX_FILES = 3000;
const BATCH = 32;
const TEXT_EXT = /\.(md|txt|json|ya?ml|toml|xml|html|css|scss|sql|sh|ps1|razor|cshtml|vue|svelte|kt|swift|scala|lua|dart)$/i;

export class SemanticIndex {
  private data?: IndexFile;
  private readonly file: string;

  constructor(private readonly host: Host, private readonly model: string, private readonly embed: Embed) {
    this.file = path.join(host.root, ".agent", "index", `${model.replace(/[^\w.-]+/g, "_")}.json`);
  }

  /** nomic-style models expect task prefixes; others take plain text. */
  private prefix(kind: "query" | "doc") {
    return /nomic/i.test(this.model) ? (kind === "query" ? "search_query: " : "search_document: ") : "";
  }

  /** Brings the index up to date with the workspace; returns how many chunks were embedded. */
  async update(signal?: AbortSignal, onProgress?: (done: number, total: number) => void): Promise<number> {
    this.data ??= await this.load();
    const files = (await listFiles(this.host)).filter((f) => languageFor(f) || TEXT_EXT.test(f)).slice(0, MAX_FILES);
    const alive = new Set(files);
    for (const f of Object.keys(this.data.files)) if (!alive.has(f)) delete this.data.files[f];
    const pending: { file: string; hash: string; chunks: Omit<Chunk, "vec">[]; texts: string[] }[] = [];
    for (const f of files) {
      const text = await this.host.readFile(f).catch(() => undefined);
      if (text === undefined || text.length > MAX_FILE_BYTES || text.includes("\u0000")) continue;
      const hash = createHash("sha1").update(text).digest("hex");
      if (this.data.files[f]?.hash === hash) continue;
      const chunks = await chunkFile(f, text);
      const lines = text.replace(/\r\n/g, "\n").split("\n");
      pending.push({ file: f, hash, chunks, texts: chunks.map((c) => `${this.prefix("doc")}${f}\n${lines.slice(c.line - 1, c.endLine).join("\n")}`) });
    }
    const total = pending.reduce((n, p) => n + p.texts.length, 0);
    let done = 0;
    for (const p of pending) {
      const vecs: number[][] = [];
      for (let i = 0; i < p.texts.length; i += BATCH) {
        vecs.push(...(await this.embed(p.texts.slice(i, i + BATCH), signal)).map(normalize));
        done += Math.min(BATCH, p.texts.length - i);
        onProgress?.(done, total);
      }
      this.data.files[p.file] = { hash: p.hash, chunks: p.chunks.map((c, i) => ({ ...c, vec: round(vecs[i]) })) };
    }
    if (pending.length) await this.save();
    return total;
  }

  async search(query: string, k = 8, signal?: AbortSignal): Promise<SearchHit[]> {
    await this.update(signal);
    const [q] = (await this.embed([`${this.prefix("query")}${query}`], signal)).map(normalize);
    const hits: SearchHit[] = [];
    for (const [f, entry] of Object.entries(this.data!.files)) {
      for (const c of entry.chunks) hits.push({ path: f, line: c.line, endLine: c.endLine, title: c.title, score: dot(q, c.vec) });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, k);
  }

  private async load(): Promise<IndexFile> {
    try {
      const d = JSON.parse(await readFile(this.file, "utf8")) as IndexFile;
      if (d.version === VERSION && d.model === this.model) return d;
    } catch {
      /* missing or corrupt: rebuild */
    }
    return { version: VERSION, model: this.model, files: {} };
  }

  private async save() {
    ensureAgentDir(this.host.root, "index");
    await writeFile(this.file, JSON.stringify(this.data));
  }
}

/** One chunk per top-level definition (long ones are cut), the gaps between them as windows. */
export async function chunkFile(file: string, text: string): Promise<Omit<Chunk, "vec">[]> {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const defs = ((await fileSymbols(file, text))?.defs ?? []).filter((d) => d.depth === 0);
  const out: Omit<Chunk, "vec">[] = [];
  let covered = 0; // last line (1-based) already in a chunk
  const windows = (from: number, to: number) => {
    for (let s = from; s <= to; s += WINDOW) {
      const e = Math.min(to, s + WINDOW - 1);
      if (lines.slice(s - 1, e).some((l) => l.trim())) out.push({ line: s, endLine: e, title: lines[s - 1].trim().slice(0, 100) });
    }
  };
  for (const d of defs) {
    if (d.line <= covered) continue;
    if (d.line - 1 > covered) windows(covered + 1, d.line - 1);
    // Long definitions are cut; the rest of their body is covered by the windows after them.
    const end = Math.min(d.endLine, d.line + CHUNK_LINES - 1);
    out.push({ line: d.line, endLine: end, title: d.signature });
    covered = end;
  }
  if (covered < lines.length) windows(covered + 1, lines.length);
  return out;
}

function normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

/** 4 decimals is plenty for cosine ranking and keeps the cache small. */
function round(v: number[]): number[] {
  return v.map((x) => Math.round(x * 1e4) / 1e4);
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length && i < b.length; i++) s += a[i] * b[i];
  return s;
}

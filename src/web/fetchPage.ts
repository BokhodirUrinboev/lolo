import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFile, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import * as path from "node:path";
import { ensureAgentDir } from "../edit/agentDir";
import { htmlTitle, htmlToMarkdown } from "./html";

/**
 * Downloads a web page for the model: http(s) only, no local or private network
 * addresses (checked on every redirect), size and time limits, HTML converted to
 * Markdown, cached in .agent/cache/web for a day.
 */

const MAX_BYTES = 3_000_000;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const CACHE_MS = 24 * 3600_000;

export interface Page {
  url: string;
  title: string;
  text: string;
}

export function privateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return privateAddress(mapped[1]);
    return x === "::" || x === "::1" || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x);
  }
  return true;
}

/** Why `url` may not be fetched, or undefined when it is a public http(s) address. */
export async function blockedReason(url: string): Promise<string | undefined> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "not a valid URL";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "only http and https URLs can be fetched";
  if (u.username || u.password) return "URLs with credentials are not fetched";
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) return "local addresses are not fetched";
  let addrs: string[];
  try {
    addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    return `could not resolve ${host}`;
  }
  if (addrs.some(privateAddress)) return "local and private network addresses are not fetched";
  return undefined;
}

export async function fetchPage(url: string, root?: string, signal?: AbortSignal): Promise<Page> {
  const cacheFile = root ? path.join(root, ".agent", "cache", "web", createHash("sha1").update(url).digest("hex") + ".json") : undefined;
  if (cacheFile) {
    try {
      if (Date.now() - (await stat(cacheFile)).mtimeMs < CACHE_MS) return JSON.parse(await readFile(cacheFile, "utf8")) as Page;
    } catch {
      /* not cached */
    }
  }
  let current = url;
  for (let hop = 0; ; hop++) {
    const blocked = await blockedReason(current);
    if (blocked) throw new Error(`${current}: ${blocked}`);
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const res = await fetch(current, {
      redirect: "manual",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AgentLolo/0.4; +https://github.com/Nodirbek-Abdulaxadov/lolo)", Accept: "text/html,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.5" },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (hop >= MAX_REDIRECTS) throw new Error("too many redirects");
      current = new URL(res.headers.get("location")!, current).toString();
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/|json|xml|markdown/.test(type) && type) throw new Error(`not a text page (${type.split(";")[0]})`);
    const raw = await readLimited(res);
    const html = /html/.test(type) || /^\s*<(!doctype|html)/i.test(raw);
    const page: Page = { url: current, title: html ? htmlTitle(raw) : "", text: html ? htmlToMarkdown(raw) : raw.trim() };
    if (cacheFile && root) {
      ensureAgentDir(root, "cache/web");
      await writeFile(cacheFile, JSON.stringify(page)).catch(() => undefined);
    }
    return page;
  }
}

async function readLimited(res: Response): Promise<string> {
  if (!res.body) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > MAX_BYTES) break;
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_BYTES));
}

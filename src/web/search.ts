import { decodeEntities } from "./html";

/**
 * Web search providers. SearXNG is the local-first option (a self-hosted
 * meta-search instance); Brave and Tavily need an API key; DuckDuckGo's HTML page
 * needs nothing but may rate-limit.
 */

export type WebProvider = "searxng" | "brave" | "tavily" | "duckduckgo";

export interface WebConfig {
  provider: WebProvider;
  /** SearXNG base URL, e.g. http://localhost:8080 (the instance must allow `format=json`). */
  searxngUrl?: string;
  apiKey?: string;
  /** Recorded answers instead of the network (eval tasks, tests). */
  replay?: WebRecording;
}

/** Search results and pages served instead of the network. */
export interface WebRecording {
  /** Tried in order: the first entry whose `match` (a case-insensitive regex) matches the query; no `match` = any query. */
  search: { match?: string; results: SearchResult[] }[];
  /** Pages by URL. */
  pages: Record<string, { title?: string; text: string }>;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const TIMEOUT_MS = 15_000;
const MAX_RESULTS = 6;

export async function webSearch(cfg: WebConfig, query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  if (cfg.replay) return (cfg.replay.search.find((e) => !e.match || new RegExp(e.match, "i").test(query))?.results ?? []).slice(0, MAX_RESULTS);
  const s = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
  let results: SearchResult[];
  try {
    results = await SEARCHERS[cfg.provider](cfg, query, s);
  } catch (e) {
    // "fetch failed" (a dropped connection) is usually transient: one retry.
    if (!(e instanceof TypeError) || s.aborted) throw e;
    results = await SEARCHERS[cfg.provider](cfg, query, s);
  }
  return results.filter((r) => /^https?:\/\//.test(r.url)).slice(0, MAX_RESULTS);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(res: Response): Promise<any> {
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const clean = (s: unknown) => decodeEntities(String(s ?? "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

const SEARCHERS: Record<WebProvider, (cfg: WebConfig, q: string, signal: AbortSignal) => Promise<SearchResult[]>> = {
  async searxng(cfg, q, signal) {
    if (!cfg.searxngUrl) throw new Error("set localAgent.web.searxngUrl to your SearXNG instance");
    const url = `${cfg.searxngUrl.replace(/\/$/, "")}/search?format=json&q=${encodeURIComponent(q)}`;
    const data = await json(await fetch(url, { signal }));
    return (data.results ?? []).map((r: { title?: string; url?: string; content?: string }) => ({ title: clean(r.title), url: String(r.url), snippet: clean(r.content) }));
  },
  async brave(cfg, q, signal) {
    if (!cfg.apiKey) throw new Error("no Brave Search API key (run \"Agent Lolo: Set Web Search API Key\")");
    const data = await json(
      await fetch(`https://api.search.brave.com/res/v1/web/search?count=${MAX_RESULTS}&q=${encodeURIComponent(q)}`, {
        signal,
        headers: { Accept: "application/json", "X-Subscription-Token": cfg.apiKey },
      }),
    );
    return (data.web?.results ?? []).map((r: { title?: string; url?: string; description?: string }) => ({ title: clean(r.title), url: String(r.url), snippet: clean(r.description) }));
  },
  async tavily(cfg, q, signal) {
    if (!cfg.apiKey) throw new Error("no Tavily API key (run \"Agent Lolo: Set Web Search API Key\")");
    const data = await json(
      await fetch("https://api.tavily.com/search", {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ query: q, max_results: MAX_RESULTS }),
      }),
    );
    return (data.results ?? []).map((r: { title?: string; url?: string; content?: string }) => ({ title: clean(r.title), url: String(r.url), snippet: clean(r.content) }));
  },
  async duckduckgo(_cfg, q, signal) {
    const res = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AgentLolo" },
      body: `q=${encodeURIComponent(q)}`,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseDuckDuckGo(await res.text());
  },
};

/** Results of DuckDuckGo's HTML page; links go through a redirect with the target in `uddg`. */
export function parseDuckDuckGo(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const anchors = [...html.matchAll(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  anchors.forEach((m, i) => {
    // The snippet sits between this result's link and the next one.
    const segment = html.slice(m.index! + m[0].length, anchors[i + 1]?.index ?? html.length);
    const snippet = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/.exec(segment)?.[1];
    let url = decodeEntities(m[1]);
    const target = /[?&]uddg=([^&]+)/.exec(url)?.[1];
    if (target) url = decodeURIComponent(target);
    if (url.startsWith("//")) url = "https:" + url;
    if (/duckduckgo\.com\/y\.js/.test(url)) return; // ads
    out.push({ title: clean(m[2]), url, snippet: clean(snippet) });
  });
  return out;
}

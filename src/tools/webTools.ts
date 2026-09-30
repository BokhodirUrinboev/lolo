import { blockedReason, fetchPage } from "../web/fetchPage";
import { webSearch } from "../web/search";
import { fail, ok, ToolContext, ToolDef } from "./types";

/**
 * Web tools, off unless the user configured a search provider. Everything that
 * leaves the machine is shown for approval first. Long pages are not pasted into
 * the context: a separate model call extracts the parts relevant to the question.
 */

/** Pages up to this size are returned whole. */
const WHOLE_PAGE_CHARS = 8_000;
const PIECE_CHARS = 12_000;
const MAX_PIECES = 4;

async function approve(ctx: ToolContext, what: string, reason: string): Promise<string | undefined> {
  const a = ctx.host.approveCommand ? await ctx.host.approveCommand(what, reason) : { ok: await ctx.host.confirm(`${what}? (${reason})`) };
  if (a.ok) return undefined;
  // Small models otherwise fill the gap from memory (a made-up version or port).
  return `The user declined: ${what}.${a.feedback ? ` They said: ${a.feedback}` : ""} Don't guess what that would have told you: if the task needs it, call done and say which information is missing.`;
}

export const webSearchTool: ToolDef<{ query: string }> = {
  name: "web_search",
  kind: "read",
  group: "web",
  description: "Search the web (current docs, versions, error messages). Returns titles, URLs and snippets; read a page with fetch_url.",
  params: { type: "object", properties: { query: { type: "string", minLength: 2 } }, required: ["query"] },
  available: (ctx) => !!ctx.web,
  async run(a, ctx) {
    const declined = await approve(ctx, `web search "${a.query}"`, `sends this query to ${ctx.web!.provider}`);
    if (declined) return fail(declined, `web_search "${a.query}": declined`);
    try {
      const results = await webSearch(ctx.web!, a.query, ctx.signal);
      if (!results.length) return ok(`No results for "${a.query}".`, `web_search "${a.query}": no results`);
      const text = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet.slice(0, 300)}`).join("\n");
      return ok(`${text}\n[Read a result with fetch_url.]`, `web_search "${a.query}": ${results.length} results`);
    } catch (e) {
      return fail(`Web search failed: ${(e as Error).message}`, `web_search "${a.query}": failed`);
    }
  },
};

export const fetchUrl: ToolDef<{ url: string; question?: string }> = {
  name: "fetch_url",
  kind: "read",
  group: "web",
  description: "Read a web page (docs, README, changelog) as text. `question`: what you need from it; long pages are reduced to the relevant parts.",
  params: { type: "object", properties: { url: { type: "string", minLength: 8 }, question: { type: "string" } }, required: ["url"] },
  available: (ctx) => !!ctx.web,
  async check(a, ctx) {
    const blocked = await blockedReason(a.url, { resolve: !ctx.web?.replay });
    return blocked ? `Cannot fetch ${a.url}: ${blocked}.` : undefined;
  },
  async run(a, ctx) {
    const host = new URL(a.url).hostname;
    const declined = await approve(ctx, `fetch ${host}`, `downloads ${a.url}`);
    if (declined) return fail(declined, `fetch_url ${a.url}: declined`);
    let page;
    try {
      page = await fetchPage(a.url, ctx.host.root, ctx.signal, ctx.web?.replay);
    } catch (e) {
      return fail(`Could not fetch ${a.url}: ${(e as Error).message}`, `fetch_url ${a.url}: failed`);
    }
    const head = `${page.title ? `# ${page.title}\n` : ""}${page.url}\n\n`;
    if (page.text.length <= WHOLE_PAGE_CHARS || !ctx.extract) {
      const cut = page.text.length > WHOLE_PAGE_CHARS * 2 ? `\n[page cut at ${WHOLE_PAGE_CHARS * 2} of ${page.text.length} characters]` : "";
      return ok(head + page.text.slice(0, WHOLE_PAGE_CHARS * 2) + cut, `fetch_url ${a.url}: ${page.text.length} chars`);
    }
    const question = a.question?.trim() || ctx.todo || "the current task";
    const pieces: string[] = [];
    for (let i = 0; i < page.text.length && pieces.length < MAX_PIECES; i += PIECE_CHARS) pieces.push(page.text.slice(i, i + PIECE_CHARS));
    const found: string[] = [];
    for (const p of pieces) {
      const part = (await ctx.extract(p, question, ctx.signal)).trim();
      if (part && !/^NOT FOUND\.?$/i.test(part)) found.push(part);
    }
    const skipped = page.text.length > PIECE_CHARS * MAX_PIECES ? `\n[Only the first ${PIECE_CHARS * MAX_PIECES} characters were searched.]` : "";
    if (!found.length) {
      return ok(`${head}Nothing about "${question}" on this page. It starts with:\n${page.text.slice(0, 1500)}${skipped}`, `fetch_url ${a.url}: nothing relevant`);
    }
    return ok(`${head}Parts relevant to "${question}" (extracted from ${page.text.length} characters):\n\n${found.join("\n\n")}${skipped}`, `fetch_url ${a.url}: extracted`);
  },
};

export const EXTRACT_PROMPT = (question: string) =>
  `From the page text below, copy only the parts relevant to: ${question}\n` +
  "Copy code, commands, version numbers, option and API names exactly as written. Do not summarize or explain. " +
  "If nothing is relevant, reply with exactly: NOT FOUND";

/**
 * HTML → compact Markdown for the model: the main content only (article/main when
 * present), code blocks kept verbatim, navigation and scripts dropped. Regex-based on
 * purpose (no DOM dependency in the bundle); good enough for docs pages.
 */

const DROP = ["script", "style", "noscript", "svg", "template", "iframe", "nav", "footer", "header", "aside", "form", "button", "select", "canvas"];

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", copy: "©", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", laquo: "«", raquo: "»", times: "×" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, ""));

export function htmlTitle(html: string): string {
  return stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim();
}

export function htmlToMarkdown(html: string): string {
  let h = html.replace(/<!--[\s\S]*?-->/g, "");
  // Main content when the page marks it; otherwise the body.
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(h)?.[2];
  h = main ?? /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(h)?.[1] ?? h;
  for (const t of DROP) h = h.replace(new RegExp(`<${t}\\b[\\s\\S]*?<\\/${t}>`, "gi"), "");

  // Code blocks first, protected from the whitespace collapsing below.
  const blocks: string[] = [];
  h = h.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner: string) => {
    const lang = /class="[^"]*(?:language|lang)-([\w+#-]+)/i.exec(inner)?.[1] ?? "";
    const code = stripTags(inner.replace(/<br\s*\/?>/gi, "\n")).replace(/^\n+|\s+$/g, "");
    blocks.push("```" + lang + "\n" + code + "\n```");
    return `\n\n\u0000${blocks.length - 1}\u0000\n\n`;
  });

  h = h
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n: string, t: string) => `\n\n${"#".repeat(Number(n))} ${stripTags(t).trim()}\n\n`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, t: string) => "`" + stripTags(t) + "`")
    .replace(/<a\b[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, t: string) => {
      const text = stripTags(t).trim();
      return text && /^https?:/.test(href) && text !== href ? `[${text}](${href})` : text;
    })
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(tr)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|section|ul|ol|table|blockquote|dl|dt|dd|figure|h\d)\b[^>]*>/gi, "\n\n")
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<[^>]+>/g, "");
  h = decodeEntities(h)
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return h.replace(/\u0000(\d+)\u0000/g, (_, i: string) => blocks[Number(i)]);
}

import { describe, expect, it } from "vitest";
import { toolNeeds } from "../src/agent/needs";
import { EditState } from "../src/edit/formats";
import { NodeHost } from "../src/host/nodeHost";
import { resolveProfile } from "../src/providers/modelProfiles";
import { ToolRegistry } from "../src/tools/registry";
import type { ToolContext } from "../src/tools/types";
import { blockedReason, privateAddress } from "../src/web/fetchPage";
import { htmlTitle, htmlToMarkdown } from "../src/web/html";
import { parseDuckDuckGo } from "../src/web/search";

describe("htmlToMarkdown", () => {
  const page = `<html><head><title>Guide &amp; API</title><script>var x = "<p>no</p>";</script></head>
<body><nav><a href="/">Home</a> | <a href="/docs">Docs</a></nav>
<main><h1>Install</h1><p>Run the <code>install</code> command&nbsp;first:</p>
<pre><code class="language-bash">npm install foo@2.1.0
foo --init &lt;dir&gt;</code></pre>
<ul><li>Fast</li><li>See <a href="https://example.com/x">the docs</a></li></ul></main>
<footer>© 2026</footer></body></html>`;
  it("keeps the main content, headings, lists, links and code verbatim", () => {
    const md = htmlToMarkdown(page);
    expect(htmlTitle(page)).toBe("Guide & API");
    expect(md).toContain("# Install");
    expect(md).toContain("Run the `install` command first:");
    expect(md).toContain("```bash\nnpm install foo@2.1.0\nfoo --init <dir>\n```");
    expect(md).toContain("- Fast");
    expect(md).toContain("[the docs](https://example.com/x)");
    expect(md).not.toContain("Home");
    expect(md).not.toContain("var x");
    expect(md).not.toContain("2026");
  });
});

describe("fetch safety", () => {
  it("treats local and private addresses as private", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.5", "169.254.169.254", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "100.64.0.1"]) {
      expect(privateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "140.82.112.3", "2606:4700::1111"]) expect(privateAddress(ip), ip).toBe(false);
  });
  it("refuses non-http schemes, credentials and local hosts", async () => {
    expect(await blockedReason("file:///etc/passwd")).toMatch(/only http/);
    expect(await blockedReason("http://user:pw@example.com/")).toMatch(/credentials/);
    expect(await blockedReason("http://localhost:3000/")).toMatch(/local/);
    expect(await blockedReason("http://127.0.0.1:11434/api/tags")).toMatch(/private/);
    expect(await blockedReason("http://[::1]/")).toMatch(/private/);
  });
});

describe("DuckDuckGo results", () => {
  it("unwraps redirect links and skips ads", () => {
    const html = `<a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=x">Ad</a>
<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.python.org%2F3%2F&amp;rut=abc">Python <b>3</b> docs</a>
<a class="result__snippet" href="x">The official &amp; complete docs.</a>`;
    expect(parseDuckDuckGo(html)).toEqual([{ title: "Python 3 docs", url: "https://docs.python.org/3/", snippet: "The official & complete docs." }]);
  });
});

describe("web tools", () => {
  it("are offered only when configured and asked for", () => {
    expect(toolNeeds("Answer the question", "@web what is the latest version of vite?").has("web")).toBe(true);
    expect(toolNeeds("Update the parser per https://example.com/spec").has("web")).toBe(true);
    expect(toolNeeds("Add a search box to the web page").has("web")).toBe(false);
    const host = new NodeHost("/tmp");
    const ctx: ToolContext = { host, profile: resolveProfile("qwen2.5-coder:7b"), edits: new EditState(), commandAllowlist: [], needs: toolNeeds("x", "@web vite version") };
    const names = () => new ToolRegistry().enabled("ask", ctx).map((t) => t.name);
    expect(names()).not.toContain("web_search");
    ctx.web = { provider: "duckduckgo" };
    expect(names()).toEqual(expect.arrayContaining(["web_search", "fetch_url"]));
  });
});

describe("@docs", () => {
  it("reads the installed package's README and version, locally", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const root = mkdtempSync(path.join(tmpdir(), "lolo-docs-"));
    mkdirSync(path.join(root, "node_modules/left-pad"), { recursive: true });
    writeFileSync(path.join(root, "node_modules/left-pad/package.json"), '{"version":"1.3.0"}');
    writeFileSync(path.join(root, "node_modules/left-pad/README.md"), "# left-pad\nleftPad(str, len, ch)");
    const site = path.join(root, ".venv/lib/python3.12/site-packages/Flask_Login-0.6.3.dist-info");
    mkdirSync(site, { recursive: true });
    writeFileSync(path.join(site, "METADATA"), "Metadata-Version: 2.1\nName: Flask-Login\nVersion: 0.6.3\n\n# Flask-Login\nlogin_user(user)");
    const { expandMentions } = await import("../src/context/mentions");
    const host = new NodeHost(root);
    const r = await expandMentions(host, "use @docs:left-pad and @docs:flask-login here", 4000);
    expect(r.context).toContain("@docs:left-pad (version 1.3.0, node_modules/left-pad/README.md)");
    expect(r.context).toContain("leftPad(str, len, ch)");
    expect(r.context).toContain("@docs:flask-login (version 0.6.3");
    expect(r.context).toContain("login_user(user)");
    const missing = await expandMentions(host, "@docs:nothing-here", 4000);
    expect(missing.context).toContain("enable web search");
  });
});

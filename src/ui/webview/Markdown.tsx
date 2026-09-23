import DOMPurify from "dompurify";
import { Marked } from "marked";
import { useMemo } from "react";
import { post } from "./vscode";

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }) {
      return `<div class="code"><div class="code-bar"><span>${escapeHtml(lang ?? "")}</span><span><button data-act="apply" title="Apply to the selection in the active editor">Apply</button><button data-act="copy">Copy</button></span></div><pre><code>${escapeHtml(text)}</code></pre></div>`;
    },
  },
});

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text]);
  const onClick = (e: React.MouseEvent) => {
    const btn = (e.target as HTMLElement).closest("button[data-act]");
    if (!btn) return;
    const code = btn.closest(".code")?.querySelector("code")?.textContent ?? "";
    if (btn.getAttribute("data-act") === "copy") void navigator.clipboard.writeText(code);
    else post({ type: "applyCode", code });
  };
  return <div className="md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

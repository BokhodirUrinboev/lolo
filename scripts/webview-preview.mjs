// Renders the chat webview outside VS Code for visual checks:
//   node scripts/webview-preview.mjs [scenario] → dist/webview/preview-<scenario>.html
// Serve dist/webview over http (ES modules don't load from file://) and open or
// screenshot it, e.g. google-chrome --headless=new --screenshot=out.png --window-size=440,1000 URL
import { writeFileSync } from "node:fs";

const t0 = Date.now() - 14_000;
const diff = ["@@ -12,6 +12,10 @@", "   total() {", "-    return this.items.reduce((sum, i) => sum + i.price, 0);", "+    return this.items.reduce((sum, i) => sum + i.price * i.qty, 0);", "+  }", "+", "+  applyDiscount(percent) {", "+    return this.total() * (1 - percent / 100);", "   }", " }"].join("\n");

const scenarios = {
  conversation: {
    sessionId: "1",
    title: "Cart.total() quantity bug",
    sessions: [{ id: "1", title: "Cart.total() quantity bug", updatedAt: Date.now() }, { id: "0", title: "create simple todo api in .net", updatedAt: Date.now() - 86400e3 }],
    activeFile: "src/cart.js",
    models: ["qwen3.5:9b", "qwen2.5-coder:7b"],
    model: "qwen3.5:9b",
    mode: "agent",
    running: true,
    autoAccept: false,
    context: { used: 5230, total: 65536 },
    turns: [
      {
        id: String(t0 - 60_000),
        running: false,
        items: [
          { kind: "user", text: "Cart.total() quantity'ni hisobga olmayapti, tuzat.", mode: "agent", context: ["src/cart.js"] },
          { kind: "plan", goal: "Fix Cart.total() to multiply price by quantity", todos: ["Fix total() in src/cart.js to multiply price by qty"], states: ["done"] },
          { kind: "thought", text: "Read the file first to see how total() is computed." },
          { kind: "tool", tool: "read_file", target: "src/cart.js", title: "read_file src/cart.js: 21 lines; class Cart", ok: true, output: "class Cart {\n  ...\n}" },
          { kind: "tool", tool: "edit", target: "src/cart.js", title: "edit src/cart.js: failed (`search` was not found in the file)", ok: false, output: "Edit failed" },
          { kind: "approval", id: "a0", action: "edit", target: "src/cart.js", detail: diff, state: "yes" },
          { kind: "verify", ok: true, output: "$ node --test\nexit code 0\nℹ pass 1" },
          { kind: "result", status: "done", summary: "Fixed `Cart.total()` so it multiplies each item's **price by its quantity**. Tests pass.", changed: ["src/cart.js"], checkpoint: "abc", stats: "4 steps · 4 tool calls · 1/1 edits · 17.1s" },
        ],
      },
      {
        id: String(t0),
        running: true,
        items: [
          { kind: "user", text: "Add applyDiscount(percent) to Cart", mode: "agent", context: ["src/cart.js"] },
          { kind: "plan", todos: ["Add applyDiscount(percent) to src/cart.js", "Test it in test/cart.test.js"], states: ["active", "pending"] },
          { kind: "tool", tool: "read_file", target: "src/cart.js", title: "read_file src/cart.js: 21 lines; class Cart", ok: true, output: "" },
          { kind: "approval", id: "a1", action: "edit", target: "src/cart.js", detail: diff, state: "pending" },
        ],
      },
    ],
  },
  empty: {
    sessionId: "2", title: "", sessions: [], activeFile: "README.md", models: ["qwen3.5:9b"], model: "qwen3.5:9b",
    mode: "agent", running: false, autoAccept: false, context: { used: 0, total: 32768 }, turns: [],
    setup: { problem: "no-model", model: "qwen2.5-coder:7b", endpoint: "http://localhost:11434", installed: ["qwen3.5:9b"] },
  },
  welcome: {
    sessionId: "4", title: "", sessions: [], activeFile: "src/cart.js", models: ["qwen3.5:9b"], model: "qwen3.5:9b",
    mode: "agent", running: false, autoAccept: false, context: { used: 0, total: 65536 }, turns: [],
  },
  command: {
    sessionId: "3", title: "create simple todo api in .net", sessions: [], models: ["qwen3.5:9b"], model: "qwen3.5:9b",
    mode: "agent", running: true, autoAccept: true, context: { used: 2100, total: 65536 },
    turns: [
      {
        id: String(t0),
        running: false,
        items: [
          { kind: "user", text: "create simple todo api in .net asp.net core", mode: "plan" },
          { kind: "plan", goal: "Create a simple todo API in ASP.NET Core", todos: ["Create a new ASP.NET Core Web API project using dotnet new webapi -n TodoApi"], states: ["pending"] },
          { kind: "result", status: "planned", summary: "Plan ready. Edit it by replying, or run it as is.", changed: [], stats: "2.1s" },
        ],
      },
      {
        id: String(t0 + 1),
        running: true,
        items: [
          { kind: "user", text: "ishni boshla", mode: "agent" },
          { kind: "approval", id: "c1", action: "command", target: "dotnet new webapi -n TodoApi", detail: "not on the command allowlist", state: "pending" },
        ],
      },
    ],
  },
  // New tool kinds: image attachment, rename across files, MCP and web rows.
  tools: {
    sessionId: "3", title: "Rename calcTotal", sessions: [], activeFile: "src/pricing.js",
    models: ["qwen3.5:9b"], model: "qwen3.5:9b", mode: "agent", running: true, autoAccept: false, context: { used: 3400, total: 65536 },
    turns: [
      {
        id: String(t0 + 2),
        running: true,
        items: [
          { kind: "user", text: "Rename calcTotal to computeTotal everywhere, and note it in the tracker", mode: "agent", context: ["src/pricing.js"], images: 1 },
          { kind: "plan", goal: "Rename calcTotal to computeTotal", todos: ["Rename calcTotal to computeTotal everywhere", "Save a note with the notes server"], states: ["active", "pending"] },
          { kind: "tool", tool: "find_references", target: "calcTotal", title: "find_references calcTotal: 5 in 3 files", ok: true, output: "src/pricing.js:1: function calcTotal(lines) {\nsrc/order.js:3: return `${order.id}: ${calcTotal(order.lines)}`;" },
          { kind: "tool", tool: "mcp__notes__list_notes", target: undefined, title: "notes.list_notes: - upgrade vite to v8", ok: true, output: "- upgrade vite to v8" },
          { kind: "tool", tool: "web_search", target: "vite 8 migration", title: "web_search \"vite 8 migration\": 6 results", ok: true, output: "1. Migration from v7 | Vite\n   https://vite.dev/guide/migration" },
          {
            kind: "approval", id: "r1", action: "edit", target: "3 files (rename calcTotal → computeTotal)", state: "pending",
            detail: ["@@ src/pricing.js", "@@ -1,3 +1,3 @@", "-function calcTotal(lines) {", "+function computeTotal(lines) {", "@@ src/order.js", "@@ -1,2 +1,2 @@", "-const { calcTotal } = require(\"./pricing\");", "+const { computeTotal } = require(\"./pricing\");"].join("\n"),
          },
        ],
      },
    ],
  },
};

// THEME=dark-modern: VS Code's default dark theme (used for README screenshots).
const darkModern = {
  "--vscode-foreground": "#cccccc",
  "--vscode-descriptionForeground": "#9d9d9d",
  "--vscode-sideBar-background": "#181818",
  "--vscode-editor-background": "#1f1f1f",
  "--vscode-input-background": "#313131",
  "--vscode-input-foreground": "#cccccc",
  "--vscode-focusBorder": "#0078d4",
  "--vscode-button-background": "#0078d4",
  "--vscode-button-foreground": "#ffffff",
  "--vscode-button-hoverBackground": "#026ec1",
  "--vscode-button-secondaryBackground": "#313131",
  "--vscode-button-secondaryForeground": "#cccccc",
  "--vscode-textLink-foreground": "#4daafc",
  "--vscode-charts-orange": "#d18616",
  "--vscode-font-family": "system-ui, sans-serif",
  "--vscode-font-size": "13px",
  "--vscode-editor-font-family": "'DejaVu Sans Mono', monospace",
  "--vscode-editor-font-size": "12px",
};
// Default: a dark purple theme with a yellow accent.
const purple = {
  "--vscode-foreground": "#cfc8f0",
  "--vscode-descriptionForeground": "#8f89b3",
  "--vscode-sideBar-background": "#141326",
  "--vscode-editor-background": "#16152a",
  "--vscode-input-background": "#1a1930",
  "--vscode-input-foreground": "#e2dcff",
  "--vscode-focusBorder": "#d4a72c",
  "--vscode-button-background": "#a07c14",
  "--vscode-button-foreground": "#fff6dc",
  "--vscode-button-hoverBackground": "#b58c18",
  "--vscode-button-secondaryBackground": "#2a2842",
  "--vscode-button-secondaryForeground": "#e2dcff",
  "--vscode-textLink-foreground": "#e0b53a",
  "--vscode-font-family": "system-ui, sans-serif",
  "--vscode-font-size": "13px",
  "--vscode-editor-font-family": "'DejaVu Sans Mono', monospace",
  "--vscode-editor-font-size": "12px",
};

const theme = process.env.THEME === "dark-modern" ? darkModern : purple;

for (const [name, state] of Object.entries(scenarios)) {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="stylesheet" href="index.css">
<style>:root{${Object.entries(theme).map(([k, v]) => `${k}:${v}`).join(";")}}</style>
<script>window.acquireVsCodeApi=()=>({postMessage:(m)=>console.log(JSON.stringify(m)),getState:()=>({}),setState:()=>{}});
setTimeout(()=>{window.postMessage({type:"state",state:${JSON.stringify(state)}},"*");${name === "conversation" ? `window.postMessage({type:"streaming",thought:"Adding applyDiscount after total() and keeping the class structure intact"},"*");` : ""}},50);</script>
</head><body><div id="root"></div><script type="module" src="index.js"></script></body></html>`;
  writeFileSync(`dist/webview/preview-${name}.html`, html);
}
console.log(Object.keys(scenarios).map((n) => `dist/webview/preview-${n}.html`).join("\n"));

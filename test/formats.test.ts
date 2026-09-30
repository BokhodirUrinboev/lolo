import { describe, expect, it } from "vitest";
import { applyLineRange, EditState, editToolFor, enabledEditTools, isLazyPlaceholder, mergeLazyRewrite } from "../src/edit/formats";
import { resolveProfile } from "../src/providers/modelProfiles";

const original = ["import x from 'x';", "", "export function a() {", "  return 1;", "}", "", "export function b() {", "  return 2;", "}"].join("\n");

describe("lazy placeholders", () => {
  it("detects common placeholder comments", () => {
    const set = new Set<string>();
    for (const l of ["// ... existing code ...", "  # ... rest of the file unchanged", "/* ... */", "// rest of the code remains the same", "<!-- ... -->", "..."]) {
      expect(isLazyPlaceholder(l, set), l).toBe(true);
    }
    for (const l of ["const xs = [...a];", "// TODO: handle errors", "return ...args;"]) {
      expect(isLazyPlaceholder(l, set), l).toBe(false);
    }
  });

  it("does not treat `...` as a placeholder when the original has it", () => {
    expect(isLazyPlaceholder("    ...", new Set(["..."]))).toBe(false);
  });

  it("merges omitted regions from the original", () => {
    const proposed = ["import x from 'x';", "", "// ... existing code ...", "", "export function b() {", "  return 3;", "}"].join("\n");
    const r = mergeLazyRewrite(original, proposed);
    expect(r.ok).toBe(true);
    expect(r.ok && r.content).toBe(original.replace("return 2", "return 3"));
  });

  it("keeps new lines next to a placeholder and fills after them", () => {
    const proposed = ["import y from 'y';", "// ... rest of file unchanged"].join("\n");
    const r = mergeLazyRewrite(original, proposed);
    expect(r.ok && r.content).toBe("import y from 'y';\n" + original);
  });

  it("appends new code after a leading placeholder", () => {
    const proposed = ["// ... existing code ...", "", "export function c() {}"].join("\n");
    const r = mergeLazyRewrite(original, proposed);
    expect(r.ok && r.content).toBe(original + "\n\nexport function c() {}");
  });

  it("fails when anchors are out of order", () => {
    const proposed = ["export function b() {", "// ... existing code ...", "import x from 'x';"].join("\n");
    const r = mergeLazyRewrite(original, proposed);
    expect(r.ok).toBe(false);
  });
});

describe("applyLineRange", () => {
  it("replaces a range", () => {
    const r = applyLineRange(original, 4, 4, "  return 100;");
    expect(r.ok && r.content.split("\n")[3]).toBe("  return 100;");
  });
  it("inserts with end = start - 1", () => {
    const r = applyLineRange(original, 1, 0, "// header");
    expect(r.ok && r.content.split("\n").slice(0, 2)).toEqual(["// header", "import x from 'x';"]);
  });
  it("rejects out-of-range lines", () => {
    expect(applyLineRange(original, 20, 20, "x").ok).toBe(false);
  });
});

describe("edit format policy", () => {
  it("switches a file to line-range after repeated failures", () => {
    const profile = resolveProfile("qwen2.5-coder-32k:latest");
    const s = new EditState();
    expect(enabledEditTools(profile, s)).toEqual(["edit", "rewrite_file"]);
    expect(s.recordFailure("a.ts")).toBe(false);
    expect(s.recordFailure("a.ts")).toBe(true);
    expect(s.isLineRange("a.ts")).toBe(true);
    expect(enabledEditTools(profile, s)).toContain("edit_lines");
    expect(editToolFor(profile, s, "a.ts", 500)).toBe("edit_lines");
    expect(editToolFor(profile, s, "b.ts", 20)).toBe("rewrite_file");
    expect(editToolFor(profile, s, "b.ts", 500)).toBe("edit");
  });
});

describe("blank-line runs", async () => {
  const { collapseBlankRuns, maxBlankRun } = await import("../src/edit/text");
  it("collapses degenerate blank runs", () => {
    expect(collapseBlankRuns("a\n\n\n\n\n\nb\n\nc", 2)).toBe("a\n\n\nb\n\nc");
    expect(maxBlankRun("a\n\n\nb")).toBe(2);
  });
});

describe("resolveProfile", () => {
  it("matches built-ins with or without a registry namespace", () => {
    expect(resolveProfile("qwen3.5:9b").think).toBe(false);
    expect(resolveProfile("huihui_ai/qwen3.5-abliterated:9b").think).toBe(false);
    expect(resolveProfile("qwen3.5:9b").fim).toBeUndefined();
    expect(resolveProfile("qwen2.5-coder:7b").fim).toBeDefined();
    expect(resolveProfile("some/unknown:1b").ctx).toBe(8192);
  });

  it("knows the common families, the longest match winning", () => {
    expect(resolveProfile("qwen2.5:7b").ctx).toBe(32768);
    expect(resolveProfile("qwen2.5:7b").fim).toBeUndefined();
    expect(resolveProfile("qwen2.5-coder:1.5b").fim?.prefix).toBe("<|fim_prefix|>");
    expect(resolveProfile("qwen3:8b")).toMatchObject({ ctx: 32768, think: false });
    expect(resolveProfile("qwen3-coder:30b").ctx).toBe(65536);
    expect(resolveProfile("qwen3.5:9b").ctx).toBe(65536);
    expect(resolveProfile("llama3.1:8b").ctx).toBe(32768);
    expect(resolveProfile("deepseek-coder-v2:16b").fim?.middle).toBe("<｜fim▁end｜>");
    expect(resolveProfile("starcoder2:3b").fim?.prefix).toBe("<fim_prefix>");
  });
  it("lets user overrides win", () => {
    expect(resolveProfile("qwen3.5:9b", [{ match: "qwen3.5", ctx: 131072 }]).ctx).toBe(131072);
  });
});

describe("mergeLazyRewrite: placeholder-like comments in complete rewrites", () => {
  it("keeps a full rewrite whose comment only looks like a placeholder", () => {
    const orig = 'const test = require("node:test");\nconst { Cart } = require("../src/cart");\n\ntest("total", () => {\n  const c = new Cart();\n  c.add("apple", 2, 3);\n});\n';
    const proposed = "const test = require('node:test');\nconst { Cart } = require('../src/cart');\n\n// Existing tests...\ntest('total', () => {\n  const c = new Cart();\n  c.add('apple', 2, 3);\n});\n\ntest('discount', () => {});\n";
    const r = mergeLazyRewrite(orig, proposed);
    expect(r).toEqual({ ok: true, content: proposed, filled: 0 });
  });
});

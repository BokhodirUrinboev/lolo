import { describe, expect, it } from "vitest";
import { buildFimPrompt, CompletionCache, postprocessCompletion } from "../src/autocomplete/fim";
import { resolveProfile } from "../src/providers/modelProfiles";

const qwen = resolveProfile("qwen2.5-coder:7b").fim!;

describe("buildFimPrompt", () => {
  it("uses repo-level format with context files", () => {
    const p = buildFimPrompt(qwen, { path: "src/a.ts", prefix: "const x = ", suffix: ";\n", context: [{ path: "src/b.ts", text: "export function b(): number" }] });
    expect(p).toBe("<|file_sep|>src/b.ts\nexport function b(): number\n<|file_sep|>src/a.ts\n<|fim_prefix|>const x = <|fim_suffix|>;\n<|fim_middle|>");
  });
  it("is plain FIM without context", () => {
    expect(buildFimPrompt(qwen, { path: "a.py", prefix: "p", suffix: "s" })).toBe("<|fim_prefix|>p<|fim_suffix|>s<|fim_middle|>");
  });
});

describe("postprocessCompletion", () => {
  it("completes only the current line when the cursor is mid-line", () => {
    expect(postprocessCompletion("price * qty, 0);\n  }\n}", "return items.reduce((s, i) => s + i.", ", 0);\n")).toBe("price * qty");
  });

  it("stops at the block the completion did not open", () => {
    const prefix = "class A {\n  total() {\n    ";
    const suffix = "\n  }\n}\n";
    expect(postprocessCompletion("const t = 1;\n    return t;\n  }\n\n  other() {\n  }", prefix, suffix)).toBe("const t = 1;\n    return t;");
  });

  it("keeps a complete new block", () => {
    const prefix = "class A {\n  ";
    const suffix = "\n}\n";
    expect(postprocessCompletion("add(x) {\n    this.items.push(x);\n  }\n}", prefix, suffix)).toBe("add(x) {\n    this.items.push(x);\n  }");
  });

  it("stops at a dedent in Python", () => {
    const prefix = "def f(x):\n    ";
    expect(postprocessCompletion("y = x * 2\n    return y\n\ndef g():\n    pass", prefix, "\n")).toBe("y = x * 2\n    return y");
  });

  it("drops a tail that repeats the suffix", () => {
    expect(postprocessCompletion("if (x) {\n    run();\n  }\n  return 1;", "  ", "\n  return 1;\n}")).toBe("if (x) {\n    run();\n  }");
  });
});

describe("CompletionCache", () => {
  it("serves the rest of a suggestion while the user types it", () => {
    const c = new CompletionCache();
    c.set("const a = ", "", "foo(bar);");
    expect(c.get("const a = fo", "")).toBe("o(bar);");
    expect(c.get("const a = x", "")).toBeUndefined();
  });
});

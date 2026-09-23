import { describe, expect, it } from "vitest";
import { extractCode, matchIndent } from "../src/inline/inlineEditPrompt";

describe("inline edit helpers", () => {
  it("extracts the fenced block", () => {
    expect(extractCode("Here:\n```ts\nconst a = 1;\n```\nDone")).toBe("const a = 1;");
    expect(extractCode("const a = 1;")).toBe("const a = 1;");
  });
  it("restores dropped indentation", () => {
    expect(matchIndent("if (x) {\n  y();\n}", "    if (a) {\n      b();\n    }")).toBe("    if (x) {\n      y();\n    }");
    expect(matchIndent("    ok();", "    old();")).toBe("    ok();");
  });
});

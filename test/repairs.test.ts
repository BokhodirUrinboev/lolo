import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { laterTodoFor } from "../src/agent/loop";
import { dropLookOnlyTodos, mergeTodos, namedFiles } from "../src/agent/planner";
import { isTestFile, protectTests } from "../src/agent/testGuard";
import { EditState } from "../src/edit/formats";
import { fuzzyApply } from "../src/edit/fuzzyApply";
import { NodeHost } from "../src/host/nodeHost";
import { resolveProfile } from "../src/providers/modelProfiles";
import { createFile, doubleEscaped, editFile, rewriteFile } from "../src/tools/fileTools";
import { addUsing, missingUsings, workspacePath } from "../src/tools/missingImports";
import { relativizePaths } from "../src/tools/output";
import { errorContext } from "../src/tools/testReport";
import { ToolRegistry } from "../src/tools/registry";
import type { ToolContext } from "../src/tools/types";

const STOCK = `function sell(inv, sku, qty) {
  const key = sku.trim();
  inv.stock.set(key, inv.stock.get(key) - qty);
}

function restock(inv, sku, qty) {
  const key = sku.trim();
  inv.stock.set(key, inv.stock.get(key) - qty);
}
`;

function workspace(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "lolo-rep-"));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), c);
  }
  const ctx: ToolContext = { host: new NodeHost(root, { autoApprove: true }), profile: resolveProfile("qwen2.5-coder:7b"), edits: new EditState(), commandAllowlist: [] };
  return { root, ctx, read: (f: string) => readFileSync(path.join(root, f), "utf8") };
}

describe("ambiguous search", () => {
  const search = "  inv.stock.set(key, inv.stock.get(key) - qty);";

  it("reports every match, and applies the one picked with `at`", () => {
    const r = fuzzyApply(STOCK, search, search.replace("-", "+"));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.matches).toEqual([3, 8]);
    const picked = fuzzyApply(STOCK, search, search.replace("-", "+"), { at: 8 });
    expect(picked.ok && picked.content.split("\n")[7]).toContain("+ qty");
    expect(picked.ok && picked.content.split("\n")[2]).toContain("- qty");
  });

  it("edits the match inside the function the todo names", async () => {
    const { ctx, read } = workspace({ "src/inv.js": STOCK });
    ctx.todo = "Make restock() in src/inv.js raise the stock";
    const r = await editFile.run({ path: "src/inv.js", search, replace: search.replace("-", "+") }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("changed the one in restock at line 8");
    expect(read("src/inv.js").split("\n")[7]).toContain("+ qty");
    expect(read("src/inv.js").split("\n")[2]).toContain("- qty");
  });

  it("limits all=true to the function the todo is about", async () => {
    const { ctx, read } = workspace({ "src/inv.js": STOCK });
    ctx.todo = "Edit the restock function in src/inv.js to raise the stock";
    const r = await editFile.run({ path: "src/inv.js", search: search.trim(), replace: search.trim().replace("-", "+"), all: true }, ctx);
    expect(r.output).toContain("only in restock");
    expect(read("src/inv.js").split("\n")[2]).toContain("- qty");
    expect(read("src/inv.js").split("\n")[7]).toContain("+ qty");
    // A rename-style all=true that the todo doesn't tie to one function changes everything.
    const { ctx: c2, read: r2 } = workspace({ "src/inv.js": STOCK });
    c2.todo = "Rename the variable key to id";
    await editFile.run({ path: "src/inv.js", search: "key", replace: "id", all: true }, c2);
    expect(r2("src/inv.js")).not.toContain("key");
  });

  it("refuses an append edit that is already in place (degenerate repeats)", () => {
    const file = "class A {\n  toString() { return 'a'; }\n}\n";
    const edit = ["  toString() { return 'a'; }", "  toString() { return 'a'; }\n\n  equals(o) { return o instanceof A; }"] as const;
    const once = fuzzyApply(file, ...edit);
    expect(once.ok).toBe(true);
    const twice = fuzzyApply(once.ok ? once.content : "", ...edit);
    expect(!twice.ok && twice.reason).toMatch(/already applied/);
  });

  it("otherwise lists the places with their functions", async () => {
    const { ctx } = workspace({ "src/inv.js": STOCK });
    ctx.todo = "Fix the stock update";
    const r = await editFile.run({ path: "src/inv.js", search, replace: "x" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("matches 2 places: line 3 (in sell), line 8 (in restock)");
  });
});

describe("replace that repeats the lines around search", () => {
  it("replaces the repeated closing lines instead of duplicating them (C#)", async () => {
    const { ctx, read } = workspace({ "SystemClock.cs": "namespace Greetings;\n\npublic class SystemClock\n{\n    public DateTime Now => DateTime.Now;\n}\n" });
    const r = await editFile.run(
      { path: "SystemClock.cs", search: "public class SystemClock\n{", replace: "public class SystemClock : IClock\n{\n    public DateTime Now => DateTime.Now;\n}" },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/replaced, not duplicated|replaced the whole old one/);
    expect(read("SystemClock.cs")).toBe("namespace Greetings;\n\npublic class SystemClock : IClock\n{\n    public DateTime Now => DateTime.Now;\n}\n");
  });

  it("handles a replace that starts with the line before search (JS)", async () => {
    const { ctx, read } = workspace({ "a.js": "function add(a, b) {\n  return a - b;\n}\n\nmodule.exports = { add };\n" });
    const r = await editFile.run({ path: "a.js", search: "  return a - b;\n}", replace: "function add(a, b) {\n  return a + b;\n}" }, ctx);
    expect(r.ok).toBe(true);
    expect(read("a.js")).toBe("function add(a, b) {\n  return a + b;\n}\n\nmodule.exports = { add };\n");
  });

  it("replaces the whole function when `replace` is a new version of the one `search` starts", async () => {
    const eu = "const { formatPrice } = require(\"./format\");\n\nfunction euPriceTag(product) {\n  return `${product.name} ${formatPrice(product.cents)}`;\n}\n\nmodule.exports = { euPriceTag };\n";
    const { ctx, read } = workspace({ "src/eu.js": eu });
    const r = await editFile.run(
      { path: "src/eu.js", search: "function euPriceTag(product)", replace: "function euPriceTag(product) {\n  return `${product.name} ${formatPrice(product.cents, \"EUR\")}`;\n}" },
      ctx,
    );
    expect(r.output).toContain("replaced the whole old one");
    expect(read("src/eu.js")).toBe(eu.replace("formatPrice(product.cents)", 'formatPrice(product.cents, "EUR")'));
    // An insertion at the top of a body (unbalanced replace) is left as it is.
    const { ctx: c2, read: r2 } = workspace({ "a.js": "function f(x) {\n  return x;\n}\n" });
    await editFile.run({ path: "a.js", search: "function f(x) {", replace: "function f(x) {\n  if (!x) return 0;" }, c2);
    expect(r2("a.js")).toBe("function f(x) {\n  if (!x) return 0;\n  return x;\n}\n");
  });

  it("accepts a one-line complete redefinition too", async () => {
    const { ctx, read } = workspace({ "SystemClock.cs": "namespace Greetings;\n\npublic class SystemClock\n{\n    public DateTime Now => DateTime.Now;\n}\n" });
    const r = await editFile.run({ path: "SystemClock.cs", search: "public class SystemClock", replace: "public class SystemClock : IClock { public DateTime Now => DateTime.Now; }" }, ctx);
    expect(r.ok).toBe(true);
    expect(read("SystemClock.cs")).toBe("namespace Greetings;\n\npublic class SystemClock : IClock { public DateTime Now => DateTime.Now; }\n");
  });

  it("leaves valid edits alone, even when they add a similar line", async () => {
    const { ctx, read } = workspace({ "b.js": "function f() {\n  a();\n}\n" });
    await editFile.run({ path: "b.js", search: "  a();", replace: "  a();\n  a();" }, ctx);
    expect(read("b.js")).toBe("function f() {\n  a();\n  a();\n}\n");
  });
});

describe("line breaks escaped twice", () => {
  it("unescapes search/replace when only the unescaped search is in the file", async () => {
    const { ctx, read } = workspace({ "src/stack.js": "class S {\n  pop() {\n    return this.items.shift();\n  }\n}\n" });
    const r = await editFile.run({ path: "src/stack.js", search: "  pop() {\\n    return this.items.shift();\\n  }", replace: "  pop() {\\n    return this.items.pop();\\n  }" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("escaped twice");
    expect(read("src/stack.js")).toBe("class S {\n  pop() {\n    return this.items.pop();\n  }\n}\n");
  });

  it("fixes new content, but not a one-line \"\\n\" inside a string", async () => {
    expect(doubleEscaped("function f() {\\n  return 1;\\n}")).toBe(true);
    expect(doubleEscaped('return lines.join("\\n");')).toBe(false);
    expect(doubleEscaped("a\nb\\n  c\\n  d")).toBe(false); // has real line breaks
    const { ctx, read } = workspace({});
    const args = { path: "a.js", content: "function f() {\\n  return 1;\\n}\\n" };
    expect(await createFile.check!(args, ctx)).toBeUndefined();
    await createFile.run(args, ctx);
    expect(read("a.js")).toBe("function f() {\n  return 1;\n}\n");
  });
});

describe("checks deferred to a later todo", () => {
  const build = "Program.cs(3,31): error CS1503: Argument 1: cannot convert from 'Greetings.SystemClock' to 'Greetings.IClock' [Clock.csproj]";
  it("defers when the errors name what a later todo changes", () => {
    expect(laterTodoFor(build, ["Edit SystemClock.cs so SystemClock implements IClock"])).toBe("Edit SystemClock.cs so SystemClock implements IClock");
    expect(laterTodoFor("ReferenceError: computeTax is not defined\n    at orderTotal (src/order.js:4:15)", ["Use computeTax in src/invoice.js"])).toBeDefined();
  });
  it("does not defer for unrelated errors or on the last todo", () => {
    expect(laterTodoFor(build, ["Add a README section"])).toBeUndefined();
    expect(laterTodoFor(build, [])).toBeUndefined();
    expect(laterTodoFor("AssertionError: Expected values to be strictly equal", ["Handle the AssertionError case"])).toBeUndefined();
  });
});

describe("syntax repairs", () => {
  it("turns `namespace X;` followed by braces into a block-scoped namespace (C#)", async () => {
    const before = "using Shop.Models;\n\nnamespace Shop.Services;\n\npublic class OrderService\n{\n    public decimal Total(Order o) => o.Lines.Sum(l => l.Price);\n}\n";
    const { ctx, read } = workspace({ "Services/OrderService.cs": before });
    const content =
      "using Shop.Models;\n\nnamespace Shop.Services;\n{\n    public class OrderService\n    {\n        public decimal Total(Order o) => o.Lines == null ? 0 : o.Lines.Sum(l => l.Price);\n    }\n}";
    const r = await rewriteFile.run({ path: "Services/OrderService.cs", content }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("namespace X { ... }");
    expect(read("Services/OrderService.cs")).toContain("namespace Shop.Services\n{");
  });
});

describe("placeholders in new code", () => {
  it("refuses stubs like `// existing implementation` in created files and edits", async () => {
    const { ctx } = workspace({ "src/users.js": "function a() {\n  return 1;\n}\n// existing implementation note\n" });
    const stub = "module.exports = {\n  validateEmail(email) {\n    // existing implementation\n  },\n};\n";
    expect(await createFile.check!({ path: "src/validators.js", content: stub }, ctx)).toMatch(/placeholder/);
    expect(await createFile.check!({ path: "src/ok.js", content: "module.exports = { a: 1 };\n" }, ctx)).toBeUndefined();
    expect(await editFile.check!({ path: "src/users.js", search: "  return 1;", replace: "  // ... rest of the code ...\n  return 2;" }, ctx)).toMatch(/placeholder/);
    // A comment that is already in the file is not a new hole.
    expect(await editFile.check!({ path: "src/users.js", search: "  return 1;", replace: "  return 1; // existing implementation note" }, ctx)).toBeUndefined();
  });
});

describe("test guard", () => {
  it("protects tests when the message is about failing tests or forbids changing them", () => {
    for (const m of [
      "`npm test` fails. Find out why and fix the code in src/ (don't change the tests).",
      "My uncommitted change to src/rate.js broke the tests. Use git diff to see what I changed.",
      "Cart.total() ignores item quantity. Fix it so the tests pass.",
      "the tests are still failing",
      "python3 -m unittest fails. Fix inventory.py (do not modify the tests)",
    ]) expect(protectTests(m), m).toBe(true);
    for (const m of [
      "Add a method applyDiscount(percent) to Cart. Add a test for it in test/cart.test.js.",
      "Rename the class ShoppingCart to Basket everywhere: its definition, its export and every use in src/ and test/.",
      "Rename the class Invoice to Bill everywhere (the billing package and the tests).",
      "The test for parseDate fails because the test is wrong: update the test to expect UTC.",
      "Implement median(xs) in stats.py.",
    ]) expect(protectTests(m), m).toBe(false);
    expect(["test/a.test.js", "src/a.spec.ts", "test_config.py", "pkg/words_test.go", "Api.Tests/UsersTests.cs", "tests/helpers.js"].every(isTestFile)).toBe(true);
    expect(["src/test-utils-free.js", "src/contest.js", "attest.py"].some(isTestFile)).toBe(false);
  });

  it("refuses edits to existing tests while protected, not new files", async () => {
    const { ctx } = workspace({ "src/a.js": "exports.a = 1;\n", "test/a.test.js": "// test\n" });
    ctx.protectTests = true;
    const reg = new ToolRegistry();
    const edit = await reg.check({ thought: "", tool: "edit", args: { path: "test/a.test.js", search: "// test", replace: "// x" } }, reg.all, ctx);
    expect(!edit.ok && edit.error).toContain("is a test");
    expect((await reg.check({ thought: "", tool: "edit", args: { path: "src/a.js", search: "1", replace: "2" } }, reg.all, ctx)).ok).toBe(true);
    expect((await reg.check({ thought: "", tool: "create_file", args: { path: "test/b.test.js", content: "// new\n" } }, reg.all, ctx)).ok).toBe(true);
  });
});

describe("mergeTodos", () => {
  it("merges consecutive todos about the same single file", () => {
    const todos = [
      "Create a new file src/tax.js.",
      "Add the function computeTax(amount) to src/tax.js.",
      "Export the computeTax function from src/tax.js.",
      "Replace the inline tax computation in src/order.js with a call to computeTax(amount).",
      "Replace the inline tax computation in src/invoice.js with a call to computeTax(amount).",
    ];
    expect(mergeTodos(todos)).toEqual([
      "Create a new file src/tax.js; then add the function computeTax(amount) to src/tax.js; then export the computeTax function from src/tax.js.",
      todos[3],
      todos[4],
    ]);
  });

  it("folds code the planner split into todos back into its todo", () => {
    const todos = ["Create a new file IClock.cs with the following content:", "```csharp", "public interface IClock", "{", "DateTime Now { get; }", "}", "```", "Make SystemClock implement IClock"];
    expect(mergeTodos(todos)).toEqual([
      "Create a new file IClock.cs with the following content:\n```csharp\npublic interface IClock\n{\nDateTime Now { get; }\n}\n```",
      "Make SystemClock implement IClock",
    ]);
  });

  it("drops todos that only look, keeping checks the user may have asked for", () => {
    const todos = [
      "Read the changes in src/rate.js using git diff.",
      "Identify the specific change that broke the tests.",
      "Locate the corresponding test in test/rate.test.js.",
      "Fix the change in src/rate.js to keep the rounding to cents.",
      "Run the tests to verify the fix.",
    ];
    expect(dropLookOnlyTodos(todos, "g")).toEqual([todos[3], todos[4]]);
    expect(dropLookOnlyTodos(["Find and fix the null check in src/a.js"], "g")).toEqual(["Find and fix the null check in src/a.js"]);
    expect(dropLookOnlyTodos(["Read src/a.js", "Review src/b.js"], "Explain the code")).toEqual(["Explain the code"]);
    expect(dropLookOnlyTodos(["Check the /health endpoint with curl"], "g")).toEqual(["Check the /health endpoint with curl"]);
  });

  it("keeps todos about different or several files apart", () => {
    const todos = ["Add applyDiscount(percent) to Cart in src/cart.js", "Add a test for it in test/cart.test.js", "Update src/a.js and src/b.js", "Fix src/a.js"];
    expect(mergeTodos(todos)).toEqual(todos);
    expect(namedFiles("Paging.cs: fix PageCount in Paging.cs")).toEqual(["Paging.cs"]);
    expect(mergeTodos(["Fix PageCount in Paging.cs", "Paging.cs: throw for size 0"])).toEqual(["Fix PageCount in Paging.cs; then Paging.cs: throw for size 0"]);
  });
});

describe("missing using directives", () => {
  it("adds after the last using, or before a file-scoped namespace", () => {
    expect(addUsing("using System;\n\nnamespace Demo;\n", "System.Text")).toBe("using System;\nusing System.Text;\n\nnamespace Demo;\n");
    expect(addUsing("namespace Demo;\r\n\r\nclass A {}\r\n", "System.Text.RegularExpressions")).toBe("using System.Text.RegularExpressions;\r\n\r\nnamespace Demo;\r\n\r\nclass A {}\r\n");
    expect(addUsing("using System.Text;\nclass A {}\n", "System.Text")).toBe("using System.Text;\nclass A {}\n");
  });

  it("reads CS0103/CS0246 errors with absolute Windows or relative paths", async () => {
    const root = "C:\\Users\\me\\AppData\\Local\\Temp\\eval-x";
    const out = [
      "C:\\Users\\me\\AppData\\Local\\Temp\\eval-x\\TextUtils.cs(14,16): error CS0103: The name 'Regex' does not exist in the current context [C:\\Users\\me\\AppData\\Local\\Temp\\eval-x\\Text.csproj]",
      "src/Report.cs(3,9): error CS0246: The type or namespace name 'StringBuilder' could not be found (are you missing a using directive or an assembly reference?)",
      "src/Report.cs(4,9): error CS0246: The type or namespace name 'Newtonsoft' could not be found",
    ].join("\n");
    const files: Record<string, string> = { "TextUtils.cs": "namespace Demo;\n", "src/Report.cs": "namespace Demo;\n" };
    const r = await missingUsings(out, root, async (p) => files[p]);
    expect(r.changes.map((c) => c.path)).toEqual(["TextUtils.cs", "src/Report.cs"]);
    expect(r.changes[0].content).toBe("using System.Text.RegularExpressions;\n\nnamespace Demo;\n");
    expect(r.note).toContain("`using System.Text;` to src/Report.cs");
    expect(workspacePath("D:\\other\\A.cs", root)).toBeUndefined();
  });
});

describe("errorContext", () => {
  const greeter = "namespace Greetings;\n\npublic class Greeter\n{\n    private readonly SystemClock _clock;\n\n    public Greeter(IClock clock) => _clock = clock;\n}\n";
  const files: Record<string, string> = { "Greeter.cs": greeter, "src/a.js": "const x = 1;\nfoo();\n", "app.py": "import os\nprint(y)\n" };
  const read = async (p: string) => files[p] ?? Promise.reject(new Error("missing"));

  it("shows the code around compiler errors, marking the line", async () => {
    const root = "C:\\w";
    const out = "C:\\w\\Greeter.cs(7,46): error CS0266: Cannot implicitly convert type 'IClock' to 'SystemClock' [C:\\w\\Clock.csproj]";
    const ctx = await errorContext(out, root, read);
    expect(ctx).toContain("Greeter.cs:");
    expect(ctx).toContain("   5 |     private readonly SystemClock _clock;");
    expect(ctx).toContain("   7 >     public Greeter(IClock clock) => _clock = clock;");
  });

  it("reads node and python locations, and skips files outside the workspace", async () => {
    expect(await errorContext("ReferenceError: foo is not defined\n    at Object.<anonymous> (/w/src/a.js:2:1)\nsrc/a.js:2:1: nope", "/w", read)).toContain("   2 > foo();");
    expect(await errorContext('  File "/w/app.py", line 2, in <module>\nNameError: y', "/w", read)).toContain("   2 > print(y)");
    expect(await errorContext('  File "/usr/lib/python3.12/json/__init__.py", line 9', "/w", read)).toBe("");
  });
});

describe("relativizePaths", () => {
  it("turns absolute workspace paths into relative ones with forward slashes", () => {
    const root = "C:\\Users\\me\\proj";
    expect(relativizePaths("C:\\Users\\me\\proj\\src\\A.cs(3,5): error CS1002 [C:\\Users\\me\\proj\\A.csproj]", root)).toBe("src/A.cs(3,5): error CS1002 [A.csproj]");
    expect(relativizePaths("at /home/u/app/src/a.js:10:3", "/home/u/app")).toBe("at src/a.js:10:3");
    expect(relativizePaths("c:/users/me/proj/x.py line 3", root)).toBe("x.py line 3");
  });
});

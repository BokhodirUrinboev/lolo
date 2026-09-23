import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRepoMap } from "../src/context/repoMap";
import { fileSymbols, syntaxError } from "../src/context/treeSitter";
import { checkEditSyntax } from "../src/edit/syntaxGuard";
import { NodeHost } from "../src/host/nodeHost";

describe("tree-sitter symbols", () => {
  it("extracts TS definitions with nesting and references", async () => {
    const s = await fileSymbols("a.ts", "export class UserService {\n  getById(id: string): User {\n    return repo.find(id);\n  }\n}\nexport function helper() {}\n");
    expect(s?.defs.map((d) => [d.name, d.depth])).toEqual([["UserService", 0], ["getById", 1], ["helper", 0]]);
    expect(s?.defs[1].signature).toBe("getById(id: string): User");
    expect(s?.refs.get("User")).toBe(1);
  });

  it("extracts C# and Python definitions", async () => {
    const cs = await fileSymbols("A.cs", "namespace N;\npublic class Order {\n  public decimal Total() => 0;\n  public int Id { get; set; }\n}\n");
    expect(cs?.defs.map((d) => d.name)).toEqual(["Order", "Total", "Id"]);
    const py = await fileSymbols("a.py", "class A:\n    def run(self):\n        pass\n");
    expect(py?.defs.map((d) => d.name)).toEqual(["A", "run"]);
  });
});

describe("syntax guard", () => {
  it("reports parse errors with a line number", async () => {
    expect(await syntaxError("a.js", "function f() { return 1; }\n")).toBeUndefined();
    expect(await syntaxError("a.js", "class A {\n  total() {\n    applyDiscount(p) {\n  }\n}\n")).toMatch(/line \d/);
    expect(await syntaxError("a.unknown", "x")).toBeNull();
  });

  it("rejects edits that break valid code, allows edits to already-broken files", async () => {
    expect(await checkEditSyntax("a.py", "def f():\n    return 1\n", "def f(:\n    return 1\n")).toMatch(/NOT changed/);
    expect(await checkEditSyntax("a.py", "def f(:\n", "def f(:\n  x\n")).toBeUndefined();
    expect(await checkEditSyntax("a.json", "{}", "{")).toMatch(/NOT changed/); // brace fallback
  });
});

describe("repo map", () => {
  it("ranks definitions referenced from focus files first and fits the budget", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "map-"));
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src/order.ts"), "import { price } from './pricing';\nexport class Order {\n  total() { return price(1); }\n}\n");
    writeFileSync(path.join(root, "src/pricing.ts"), "export function price(n: number) { return n * 2; }\nexport function unusedThing() {}\n");
    writeFileSync(path.join(root, "src/other.ts"), "export function lonely() {}\n");
    writeFileSync(path.join(root, "README.md"), "# demo\n");
    const map = await buildRepoMap(new NodeHost(root), 500, ["src/order.ts"]);
    expect(map.indexOf("src/pricing.ts")).toBeLessThan(map.indexOf("src/other.ts"));
    expect(map).toContain("function price(n: number)");
    expect(map).toContain("README.md");
    const tiny = await buildRepoMap(new NodeHost(root), 15, ["src/order.ts"]);
    expect(tiny.length).toBeLessThan(map.length);
  });
});

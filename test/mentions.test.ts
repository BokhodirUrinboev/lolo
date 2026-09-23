import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { expandMentions, parseMentions } from "../src/context/mentions";
import { NodeHost } from "../src/host/nodeHost";

describe("mentions", () => {
  it("parses mention kinds", () => {
    expect(parseMentions("fix @src/a.ts and @symbol:Cart.total, see @problems @git. email a@b is not one")).toEqual(["src/a.ts", "symbol:Cart.total", "problems", "git"]);
  });

  it("expands files, folders and symbols", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "men-"));
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src/cart.js"), "class Cart {\n  total() { return 1; }\n}\n");
    const r = await expandMentions(new NodeHost(root), "look at @src/cart.js and @src/ and @symbol:total", 2000);
    expect(r.context).toContain("@src/cart.js:\nclass Cart");
    expect(r.context).toContain("@src/ (folder):\ncart.js");
    expect(r.context).toContain("@symbol:total (src/cart.js:2)");
    expect(r.files).toEqual(["src/cart.js", "src/cart.js"]);
  });
});

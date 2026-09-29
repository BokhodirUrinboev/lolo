import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { expandSlashCommand, listSlashCommands } from "../src/context/slashCommands";
import { NodeHost } from "../src/host/nodeHost";

describe("user slash commands", () => {
  const root = mkdtempSync(path.join(tmpdir(), "lolo-cmd-"));
  mkdirSync(path.join(root, ".agent/commands"), { recursive: true });
  writeFileSync(path.join(root, ".agent/commands/review.md"), "---\ndescription: Review a file for bugs\n---\nReview $ARGUMENTS for bugs and list them. Do not change code.\n");
  writeFileSync(path.join(root, ".agent/commands/Add Tests.md"), "# Write unit tests\nAdd unit tests for the changed code.");
  const host = new NodeHost(root);

  it("lists commands with descriptions from front matter or the first line", async () => {
    expect(await listSlashCommands(host)).toEqual([
      { name: "add-tests", description: "Write unit tests" },
      { name: "review", description: "Review a file for bugs" },
    ]);
  });

  it("expands $ARGUMENTS, appends arguments otherwise, and ignores unknown commands", async () => {
    expect(await expandSlashCommand("/review src/cart.js", host)).toBe("Review src/cart.js for bugs and list them. Do not change code.");
    expect(await expandSlashCommand("/add-tests for Cart.total", host)).toBe("# Write unit tests\nAdd unit tests for the changed code.\n\nfor Cart.total");
    expect(await expandSlashCommand("/nope", host)).toBeUndefined();
    expect(await expandSlashCommand("not a command", host)).toBeUndefined();
  });
});

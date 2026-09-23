import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Checkpoints } from "../src/edit/checkpoints";

describe("Checkpoints", () => {
  it("restores modified, deleted and added files without touching the user's git", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ckpt-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(path.join(root, ".gitignore"), "secret.txt\n");
    writeFileSync(path.join(root, "a.txt"), "one");
    writeFileSync(path.join(root, "b.txt"), "keep");
    writeFileSync(path.join(root, "secret.txt"), "ignored");

    const cp = new Checkpoints(root);
    const first = await cp.create("start");

    writeFileSync(path.join(root, "a.txt"), "two");
    execFileSync("rm", [path.join(root, "b.txt")]);
    mkdirSync(path.join(root, "new"));
    writeFileSync(path.join(root, "new", "c.txt"), "added");
    writeFileSync(path.join(root, "secret.txt"), "changed");

    await cp.restore(first.id);
    expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("one");
    expect(readFileSync(path.join(root, "b.txt"), "utf8")).toBe("keep");
    expect(existsSync(path.join(root, "new", "c.txt"))).toBe(false);
    expect(readFileSync(path.join(root, "secret.txt"), "utf8")).toBe("changed"); // ignored files are left alone

    // The restore itself is undoable, and the user's repo has no commits.
    const labels = (await cp.list()).map((c) => c.label);
    expect(labels.slice(0, 2)).toEqual([`restored to ${first.id.slice(0, 8)}`, `before restore to ${first.id.slice(0, 8)}`]);
    expect(() => execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, stdio: "pipe" })).toThrow();
  });
});

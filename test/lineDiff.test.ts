import { describe, expect, it } from "vitest";
import { diffLines, mergeForReview } from "../src/edit/lineDiff";

/** Applies accept/reject decisions to a merged review document. */
function resolve(oldLines: string[], newLines: string[], accept: (id: number) => boolean): string[] {
  const hunks = diffLines(oldLines, newLines);
  const { lines, hunks: merged } = mergeForReview(oldLines, hunks);
  const out = [...lines];
  for (const h of [...merged].reverse()) {
    if (accept(h.id)) out.splice(h.start, h.removed);
    else out.splice(h.start + h.removed, h.added);
  }
  return out;
}

describe("diffLines", () => {
  const oldL = ["a", "b", "c", "d", "e", "f"];
  const newL = ["a", "B", "c", "d", "e2", "e3", "f", "g"];

  it("finds separate hunks", () => {
    expect(diffLines(oldL, newL)).toEqual([
      { oldStart: 1, removed: ["b"], added: ["B"] },
      { oldStart: 4, removed: ["e"], added: ["e2", "e3"] },
      { oldStart: 6, removed: [], added: ["g"] },
    ]);
  });

  it("accept all yields the new text, reject all the old, and mixes are per hunk", () => {
    expect(resolve(oldL, newL, () => true)).toEqual(newL);
    expect(resolve(oldL, newL, () => false)).toEqual(oldL);
    expect(resolve(oldL, newL, (id) => id === 1)).toEqual(["a", "b", "c", "d", "e2", "e3", "f"]);
  });

  it("handles new files and full deletions", () => {
    expect(resolve([""], ["x", "y"], () => true)).toEqual(["x", "y"]);
    expect(resolve(["x", "y"], [], () => true)).toEqual([]);
  });
});

describe("unifiedDiff", async () => {
  const { unifiedDiff } = await import("../src/edit/lineDiff");
  it("renders hunks with context and headers", () => {
    const old = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n") + "\n";
    const neu = ["a", "B", "c", "d", "e", "f", "g", "h", "i", "j", "k"].join("\n") + "\n";
    expect(unifiedDiff(old, neu, 1)).toBe(["@@ -1,3 +1,3 @@", " a", "-b", "+B", " c", "@@ -10,1 +10,2 @@", " j", "+k"].join("\n"));
  });
  it("shows a new file as all additions", () => {
    expect(unifiedDiff("", "x\ny\n")).toBe(["@@ -0,0 +1,2 @@", "+x", "+y"].join("\n"));
  });
  it("is empty when nothing changed", () => {
    expect(unifiedDiff("a\n", "a\n")).toBe("");
  });
});

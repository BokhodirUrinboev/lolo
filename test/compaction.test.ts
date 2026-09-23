import { describe, expect, it } from "vitest";
import { History, KEEP_RECENT } from "../src/agent/compaction";

describe("History", () => {
  it("compacts only old turns and only when over budget", () => {
    const h = new History();
    for (let i = 0; i < 6; i++) h.add(`a${i}`, `observation ${i} ` + "x".repeat(700), `summary ${i}`);
    expect(h.compactIfNeeded(1_000_000)).toBe(0);
    expect(h.compactIfNeeded(100)).toBe(6 - KEEP_RECENT);
    const users = h.messages().filter((m) => m.role === "user").map((m) => m.content);
    expect(users[0]).toBe("[compacted] summary 0");
    expect(users[5]).toContain("observation 5");
  });

  it("appends notes to the tail observation and merges consecutive user messages", () => {
    const h = new History();
    h.setPreamble([{ role: "user", content: "plan?" }, { role: "assistant", content: "{}" }]);
    h.note("Todo 1/2: do x");
    h.add("act", "obs");
    h.note("Todo 2/2: do y");
    const m = h.messages();
    expect(m.map((x) => x.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(m[2].content).toBe("Todo 1/2: do x");
    expect(m[4].content).toBe("obs\n\nTodo 2/2: do y");
  });
});

describe("partialJsonString", async () => {
  const { partialJsonString } = await import("../src/agent/loop");
  it("reads unterminated and escaped string fields", () => {
    expect(partialJsonString('{"thought": "Read the fi', "thought")).toBe("Read the fi");
    expect(partialJsonString('{"thought": "a \\"b\\"\\nc", "action"', "thought")).toBe('a "b"\nc');
    expect(partialJsonString('{"thought": "x", "action": {"tool": "done", "args": {"summary": "Answer: 4', "summary")).toBe("Answer: 4");
    expect(partialJsonString('{"thou', "thought")).toBeUndefined();
  });
});

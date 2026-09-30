import { describe, expect, it } from "vitest";
import type { Turn } from "../src/ui/protocol";
import { conversationText, pendingPlanFor } from "../src/ui/transcript";

const planned: Turn = {
  id: "1",
  running: false,
  items: [
    { kind: "user", text: "create a todo api", mode: "plan" },
    { kind: "plan", goal: "todo api", todos: ["Create project", "Add controller"], states: ["pending", "pending"] },
    { kind: "result", status: "planned", summary: "Plan ready.", changed: [], stats: "" },
  ],
};

describe("pendingPlanFor", () => {
  it("runs the pending plan on a short go-ahead in any of the supported languages", () => {
    for (const t of ["ishni boshla", "boshla", "ha", "ok", "go ahead!", "davom et", "yes, do it", "давай"]) {
      expect(pendingPlanFor([planned], t)?.todos, t).toEqual(["Create project", "Add controller"]);
    }
  });
  it("ignores new requests and turns without a pending plan", () => {
    expect(pendingPlanFor([planned], "add a delete endpoint to the controller instead")).toBeUndefined();
    expect(pendingPlanFor([planned], "why EF core?")).toBeUndefined();
    const done: Turn = { ...planned, items: [...planned.items.slice(0, 2), { kind: "result", status: "done", summary: "x", changed: [], stats: "" }] };
    expect(pendingPlanFor([done], "ok")).toBeUndefined();
  });
});

describe("conversationText", () => {
  it("renders user messages, plans and outcomes", () => {
    const text = conversationText([planned]);
    expect(text).toContain("User: create a todo api");
    expect(text).toContain("  1. Create project");
    expect(text).toContain("plan proposed above, not executed yet");
  });
});

describe("allowedKinds", async () => {
  const { allowedKinds } = await import("../src/agent/planner");
  it("never treats punctuation or plain questions as tasks", () => {
    expect(allowedKinds("???")).toEqual(["chat"]);
    expect(allowedKinds("👍")).toEqual(["chat"]);
    for (const q of ["endi qanday ishga tushiraman?", "how does auth work", "nega bu xato beryapti?", "что делает этот метод?", "what is Cart?"]) {
      expect(allowedKinds(q), q).toEqual(["question"]);
    }
    expect(allowedKinds("qalaysan?")).toEqual(["question", "chat"]);
  });
  it("keeps tasks possible for requests, even phrased as questions", () => {
    for (const t of [
      "can you add a delete endpoint?",
      "Cart.total() ni tuzat",
      "delete endpoint qo'shib ber",
      "create simple todo api",
      "ishni boshla",
      'createUser(name, email) in src/users.js must throw an Error when email is not like x@y.z',
      "Paging.PageCount returns the wrong number of pages when totalItems is not a multiple of pageSize",
    ]) {
      expect(allowedKinds(t), t).toContain("task");
    }
  });
  it("makes 'remember ...' a task (the remember tool), not small talk", () => {
    for (const t of ["Remember for future conversations that we use tabs", "From now on, use single quotes", "can you remember that the API port is 8080?", "buni eslab qol: port 8080", "Запомни: порт 8080"]) {
      expect(allowedKinds(t), t).toEqual(["task"]);
    }
    expect(allowedKinds("Do you remember what we changed yesterday?")).not.toEqual(["task"]);
  });
});

describe("uzbekHints", async () => {
  const { uzbekHints } = await import("../src/agent/glossary");
  it("glosses Uzbek dev vocabulary with verb endings", () => {
    expect(uzbekHints("endi qanday ishga tushiraman?")).toBe("(Uzbek word meanings: endi = now; qanday = how; ishga tushiraman = run / start (the app) (I))");
    expect(uzbekHints("delete endpointini ham qo‘shib ber")).toContain("qo'shib = add");
    expect(uzbekHints("Cart.total() quantity'ni hisobga olmayapti, tuzat")).toContain("tuzat = fix");
  });
  it("adds nothing for English", () => {
    expect(uzbekHints("create a simple todo api in asp.net core")).toBe("");
    expect(uzbekHints("fix the top bar")).toBe("");
  });
});

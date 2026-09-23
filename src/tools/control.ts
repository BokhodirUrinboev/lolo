import { ok, ToolDef } from "./types";

export const done: ToolDef<{ summary: string }> = {
  name: "done",
  kind: "control",
  description: "Finish the current todo item. `summary` says what was done (or the answer, in Ask mode).",
  params: { type: "object", properties: { summary: { type: "string", minLength: 1 } }, required: ["summary"] },
  run: async (a) => ok(a.summary, `done: ${a.summary.slice(0, 120)}`),
};

/** Ends a question (Ask mode). A separate tool from done: the parameter name makes the model write an answer, not a change report. */
export const answer: ToolDef<{ text: string }> = {
  name: "answer",
  kind: "control",
  description: "Give the final answer to the user's question: a complete explanation in the user's language. Only for questions.",
  params: { type: "object", properties: { text: { type: "string", minLength: 1 } }, required: ["text"] },
  run: async (a) => ok(a.text, `answer: ${a.text.slice(0, 120)}`),
};

import { fail, ok, ToolDef } from "./types";

/**
 * explore: a separate read-only run answers a question about the codebase and only
 * its answer comes back, so the main history stays small. Offered for todos that
 * name no file in big repositories, where finding the right place takes many reads.
 */
export const explore: ToolDef<{ question: string }> = {
  name: "explore",
  kind: "read",
  group: "explore",
  description:
    "Ask a helper to find something in the codebase (e.g. \"Where is the session timeout configured?\"). It reads and searches on its own and returns only the answer with file paths.",
  params: { type: "object", properties: { question: { type: "string", minLength: 8 } }, required: ["question"] },
  available: (ctx) => !!ctx.explore,
  async run(a, ctx) {
    try {
      const answer = await ctx.explore!(a.question, ctx.signal);
      return ok(`Explore result:\n${answer}`, `explore "${a.question.slice(0, 60)}": ${answer.split("\n")[0].slice(0, 100)}`);
    } catch (e) {
      return fail(`Explore failed: ${(e as Error).message}`, "explore: failed");
    }
  },
};

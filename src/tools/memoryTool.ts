import { fail, ok, ToolDef } from "./types";

/**
 * Long-term project memory: `.agent/memory.md`, one fact per line, included in every
 * system prompt (after the rules). The agent adds facts only when the user asks it to
 * remember something, and each addition is a normal reviewed edit.
 */

export const MEMORY_PATH = ".agent/memory.md";
const HEADER = "# Project memory\n\nFacts Agent Lolo keeps between conversations (edit freely).\n\n";

export const remember: ToolDef<{ fact: string }> = {
  name: "remember",
  kind: "write",
  group: "memory",
  description: `Save a lasting fact about this project or the user's preferences to ${MEMORY_PATH} (one short sentence). It is shown to you in every future conversation.`,
  params: { type: "object", properties: { fact: { type: "string", minLength: 3 } }, required: ["fact"] },
  async run(a, ctx) {
    const fact = a.fact.replace(/\s+/g, " ").trim().replace(/^[-*]\s*/, "");
    const exists = (await ctx.host.stat(MEMORY_PATH)) === "file";
    const current = exists ? await ctx.host.readFile(MEMORY_PATH) : "";
    if (current.split("\n").some((l) => l.replace(/^[-*]\s*/, "").trim().toLowerCase() === fact.toLowerCase())) {
      return ok(`Already remembered: ${fact}`, `remember: already known`);
    }
    const next = (current ? current.replace(/\n*$/, "\n") : HEADER) + `- ${fact}\n`;
    const r = await ctx.host.proposeWrite(MEMORY_PATH, next, { isNew: !exists, reason: `remember: ${fact}` });
    if (!r.applied) return fail(`The user did not want this remembered.${r.note ? ` They said: ${r.note}` : ""}`, "remember: rejected");
    return ok(`Remembered: ${fact}`, `remember: ${fact.slice(0, 80)}`, [MEMORY_PATH]);
  },
};

/** Memory text for the system prompt (without the header). */
export function memoryText(raw: string): string {
  return raw
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#") && !/^Facts Agent Lolo keeps/.test(l))
    .join("\n")
    .trim();
}

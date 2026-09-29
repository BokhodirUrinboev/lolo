import type { Host } from "../host/types";

export const RULES_PATH = ".agent/rules.md";

export interface Rules {
  text: string;
  /** `verify:` and `before-done:` commands, in file order; run after a todo that changed files. */
  verifyCommands: string[];
  /** `after-edit:` commands, run by the agent after each write. `{files}` expands to the changed files. */
  afterEdit: string[];
}

const HOOK_LINE = /^\s*[-*]?\s*(verify|before-done|after-edit):\s*`?([^`\n]+?)`?\s*$/gim;

export async function loadRules(host: Host): Promise<Rules> {
  if ((await host.stat(RULES_PATH)) !== "file") return { text: "", verifyCommands: [], afterEdit: [] };
  const text = (await host.readFile(RULES_PATH)).trim();
  const lines = [...text.matchAll(HOOK_LINE)].map((m) => ({ key: m[1].toLowerCase(), cmd: m[2].trim() }));
  return {
    text,
    verifyCommands: lines.filter((l) => l.key !== "after-edit").map((l) => l.cmd),
    afterEdit: lines.filter((l) => l.key === "after-edit").map((l) => l.cmd),
  };
}

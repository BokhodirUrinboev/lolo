import type { Host } from "../host/types";

export const RULES_PATH = ".agent/rules.md";

export interface Rules {
  text: string;
  /** Commands from `verify: <command>` lines, run after a todo that changed files. */
  verifyCommands: string[];
}

export async function loadRules(host: Host): Promise<Rules> {
  if ((await host.stat(RULES_PATH)) !== "file") return { text: "", verifyCommands: [] };
  const text = (await host.readFile(RULES_PATH)).trim();
  const verifyCommands = [...text.matchAll(/^\s*[-*]?\s*verify:\s*`?([^`\n]+?)`?\s*$/gim)].map((m) => m[1].trim());
  return { text, verifyCommands };
}

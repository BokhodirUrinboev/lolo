import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

const IGNORE = "checkpoints/\ntrajectories/\nindex/\ncache/\n";
/** Earlier default contents, upgraded in place (a user-edited file is left alone). */
const OLD_IGNORE = ["checkpoints/\ntrajectories/\n"];

/** Creates `.agent/<sub>` and keeps the agent's generated data out of the user's git. */
export function ensureAgentDir(root: string, sub: string): string {
  const agent = path.join(root, ".agent");
  const dir = path.join(agent, sub);
  mkdirSync(dir, { recursive: true });
  const file = path.join(agent, ".gitignore");
  let current: string | undefined;
  try {
    current = readFileSync(file, "utf8");
  } catch {
    /* missing */
  }
  if (current === undefined || OLD_IGNORE.includes(current)) writeFileSync(file, IGNORE);
  return dir;
}

import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

/** Creates `.agent/<sub>` and keeps the agent's generated data out of the user's git. */
export function ensureAgentDir(root: string, sub: string): string {
  const agent = path.join(root, ".agent");
  const dir = path.join(agent, sub);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(path.join(agent, ".gitignore"), "checkpoints/\ntrajectories/\n", { flag: "wx" });
  } catch {
    /* exists: leave the user's version alone */
  }
  return dir;
}

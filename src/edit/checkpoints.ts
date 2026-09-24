import { execFile } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { ensureAgentDir } from "./agentDir";

export interface Checkpoint {
  id: string;
  label: string;
  time: Date;
}

const EXCLUDES = [".agent/checkpoints/", ".agent/trajectories/", "node_modules/", "bin/", "obj/", ".vs/"];

/**
 * Snapshots of the workspace in a shadow git repo at `.agent/checkpoints`, using
 * a separate GIT_DIR so the user's own repository, index and branches are never
 * touched. The user's .gitignore files are honoured.
 */
export class Checkpoints {
  readonly gitDir: string;

  constructor(private readonly root: string) {
    this.gitDir = path.join(root, ".agent", "checkpoints");
  }

  async create(label: string): Promise<Checkpoint> {
    await this.init();
    await this.git("add", "-A");
    await this.git("commit", "-q", "--allow-empty", "--no-verify", "-m", label);
    const id = (await this.git("rev-parse", "HEAD")).trim();
    return { id, label, time: new Date() };
  }

  async list(limit = 50): Promise<Checkpoint[]> {
    if (!(await this.exists())) return [];
    const out = await this.git("log", `-n${limit}`, "--format=%H%x09%ct%x09%s");
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [id, ts, ...rest] = l.split("\t");
        return { id, label: rest.join("\t"), time: new Date(Number(ts) * 1000) };
      });
  }

  /**
   * Restores the workspace to `id`. The current state is snapshotted first, so a
   * restore is itself undoable; history stays linear (HEAD is never moved back).
   */
  async restore(id: string): Promise<Checkpoint> {
    const before = await this.create(`before restore to ${id.slice(0, 8)}`);
    const added = (await this.git("diff", "--name-only", "--diff-filter=A", "-z", id, before.id)).split("\0").filter(Boolean);
    for (const f of added) await rm(path.join(this.root, f), { force: true });
    await this.git("checkout", id, "--", ".");
    return this.create(`restored to ${id.slice(0, 8)}`);
  }

  private async exists() {
    return stat(path.join(this.gitDir, "HEAD")).then(
      () => true,
      () => false,
    );
  }

  private async init() {
    if (await this.exists()) return;
    ensureAgentDir(this.root, "checkpoints");
    await this.git("init", "-q");
    await this.git("config", "core.autocrlf", "false");
    await this.git("config", "core.quotepath", "false");
    await mkdir(path.join(this.gitDir, "info"), { recursive: true });
    await writeFile(path.join(this.gitDir, "info", "exclude"), EXCLUDES.join("\n") + "\n");
  }

  private git(...args: string[]): Promise<string> {
    const env = { ...process.env, GIT_DIR: this.gitDir, GIT_WORK_TREE: this.root };
    const fullArgs = ["-c", "user.name=Agent Lolo", "-c", "user.email=agent@localhost", "-c", "commit.gpgsign=false", ...args];
    return new Promise((resolve, reject) => {
      execFile("git", fullArgs, { cwd: this.root, env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
        err ? reject(new Error(`git ${args[0]}: ${stderr || err.message}`)) : resolve(stdout),
      );
    });
  }
}

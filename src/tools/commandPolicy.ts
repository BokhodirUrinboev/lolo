export type CommandDecision = { kind: "allow" } | { kind: "confirm"; reason: string } | { kind: "block"; reason: string };

const BLOCKED: [RegExp, string][] = [
  [/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive\s+--force|--force\s+--recursive)\b/i, "recursive forced delete"],
  [/\bsudo\b|\bsu\s+-?\b|\bdoas\b/, "privilege escalation"],
  [/\bmkfs\b|\bdd\s+if=|>\s*\/dev\/sd|\bformat\s+[a-z]:/i, "disk-level write"],
  [/:\(\)\s*\{.*\};\s*:/, "fork bomb"],
  [/\b(curl|wget)\b[^|]*\|\s*(ba|z|)sh\b/, "piping a download into a shell"],
  [/\bgit\s+push\b[^;&|]*(--force\b|-f\b)|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*f/, "destructive git operation"],
  [/\b(shutdown|reboot|halt|poweroff)\b/, "system power"],
  [/\bchmod\s+-R\s+777\b|\bchown\s+-R\b/, "recursive permission change"],
  [/\bRemove-Item\b[^;]*-Recurse[^;]*-Force|\bRemove-Item\b[^;]*-Force[^;]*-Recurse|\brd\s+\/s\s+\/q\b/i, "recursive forced delete"],
];

/**
 * Decides whether run_command may execute `command`. Blocked patterns are never
 * run; chained commands are allowed only if every part matches the allowlist.
 */
export function decideCommand(command: string, allowlist: string[], deny: string[] = []): CommandDecision {
  const cmd = command.trim();
  for (const [re, why] of BLOCKED) if (re.test(cmd)) return { kind: "block", reason: why };
  const parts0 = cmd.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean);
  const denied = parts0.find((p) => deny.some((d) => d === "*" || p === d || p.startsWith(d + " ")));
  if (denied) return { kind: "block", reason: `denied by the project's permissions (.claude/settings.json)` };
  // "*" (Claude Code's Bash(*)): every command that isn't blocked runs without asking.
  if (allowlist.includes("*")) return { kind: "allow" };
  if (/[`]|\$\(|>\s*[^&\s]|<\(/.test(cmd)) return { kind: "confirm", reason: "uses substitution or redirection" };
  const parts = cmd.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean);
  const allowed = (p: string) => allowlist.some((a) => p === a || p.startsWith(a + " "));
  return parts.length && parts.every(allowed) ? { kind: "allow" } : { kind: "confirm", reason: "not on the command allowlist" };
}

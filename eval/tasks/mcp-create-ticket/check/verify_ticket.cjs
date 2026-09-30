const { readFileSync } = require("node:fs");
let state;
try {
  state = JSON.parse(readFileSync(".agent/cache/tracker.json", "utf8"));
} catch {
  console.error("no ticket was created");
  process.exit(1);
}
const ok = state.tickets.some((t) => /expire/i.test(t.title) && /ttl/i.test(t.title) && /cache\.js$/.test(t.file ?? ""));
if (!ok) {
  console.error("no matching ticket: " + JSON.stringify(state.tickets));
  process.exit(1);
}
console.log("OK");

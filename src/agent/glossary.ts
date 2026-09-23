/**
 * English hints for common Uzbek developer vocabulary. Small coder models read
 * Uzbek poorly (qwen2.5-coder:7b restated "endi qanday ishga tushiraman?" as
 * "Understand the new message"), but follow English hints well. Deterministic and
 * appended to the task message only when Uzbek words are present.
 */

// [stem (matched at word start, apostrophes normalized), meaning]. Longer stems first.
const STEMS: [string, string][] = [
  ["ishga tushir", "run / start (the app)"],
  ["ishlamay", "does not work"],
  ["nima uchun", "why"],
  ["davom et", "continue"],
  ["tushuntir", "explain"],
  ["o'zgartir", "change"],
  ["almashtir", "replace"],
  ["to'xtat", "stop"],
  ["o'rnat", "install"],
  ["yangila", "update"],
  ["tekshir", "check / test"],
  ["ko'rsat", "show"],
  ["qo'sh", "add"],
  ["o'chir", "delete / remove"],
  ["tuzat", "fix"],
  ["yarat", "create"],
  ["sozla", "configure"],
  ["boshla", "start"],
  ["qayerda", "where"],
  ["qachon", "when"],
  ["qanaqa", "what kind of / how"],
  ["qanday", "how"],
  ["nimaga", "why"],
  ["nechta", "how many"],
  ["qaysi", "which"],
  ["nima", "what"],
  ["nega", "why"],
  ["loyiha", "project"],
  ["papka", "folder"],
  ["fayl", "file"],
  ["xato", "error / bug"],
  ["kerak", "needed / must"],
  ["iltimos", "please"],
  ["hozir", "now"],
  ["endi", "now"],
  ["keyin", "then / next"],
  ["yangi", "new"],
  ["hamma", "all"],
  ["barcha", "all"],
  ["ishla", "work / run"],
  ["yoz", "write"],
];

const norm = (s: string) => s.toLowerCase().replace(/[‘’ʻʼ`]/g, "'");

/** "(Uzbek word meanings: endi = now; qanday = how; ishga tushiraman = run / start (the app), I)" or "". */
export function uzbekHints(text: string): string {
  const t = norm(text);
  const hints: string[] = [];
  const used = new Set<string>();
  const tokens = t.match(/[a-z']+/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    const one = tokens[i];
    const two = i + 1 < tokens.length ? `${one} ${tokens[i + 1]}` : "";
    const hit = STEMS.find(([stem]) => (stem.includes(" ") ? two.startsWith(stem) : one.startsWith(stem) && (stem.length >= 4 || one === stem)));
    if (!hit) continue;
    const surface = hit[0].includes(" ") ? two : one;
    if (hit[0].includes(" ")) i++;
    if (used.has(surface)) continue;
    used.add(surface);
    hints.push(`${surface} = ${hit[1]}${suffixNote(surface)}`);
  }
  return hints.length ? `(Uzbek word meanings: ${hints.join("; ")})` : "";
}

/** Person/aspect/question endings that change the meaning of a verb. */
function suffixNote(word: string): string {
  const notes: string[] = [];
  if (/(aman|yman|man)$/.test(word)) notes.push("I");
  else if (/(asan|ysan|san)$/.test(word)) notes.push("you");
  else if (/(amiz|ymiz|miz)$/.test(word)) notes.push("we");
  if (/yap(ti|man|san)/.test(word)) notes.push("in progress");
  if (/(ib ber|ber)$/.test(word)) notes.push("for me");
  if (/mi$/.test(word)) notes.push("question");
  return notes.length ? ` (${notes.join(", ")})` : "";
}

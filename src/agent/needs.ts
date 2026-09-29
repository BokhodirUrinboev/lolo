import type { ToolGroup } from "../tools/types";

const GIT = /\bgit\b|\bcommits?\b|\bblame\b|\bwho (changed|wrote|added|introduced)\b|\buncommitted\b|\bstaged\b|\bchange ?log\b/i;

const FILE_OPS =
  /\b(move|delete|remove|rename)\s+(the\s+|this\s+|that\s+|old\s+|unused\s+)?(\w+\s+)?(files?|folders?|director(y|ies))\b|\b(move|delete|rename)\s+\S+\.\w{1,5}\b|\b(files?|folders?)\b[^.\n]*\b(moved?|deleted?|removed?|renamed?)\b|ko'?chir|o'?chir|перемест|удали|переимен/i;

const REFACTOR =
  /\brenam(e|ing)\b|\breferences?\b|\busages?\b|\bcallers?\b|\bwhere\b[^.\n]*\b(used|called|defined|declared)\b|\bdefin(ed|ition)\b|\ball (uses|calls)\b|nomini o'?zgartir|qayerda (ishlatil|chaqiril|e'?lon)|переимен|где (использ|вызыва|определ)/i;

const PROCESS =
  /\bcurl\b|\blocalhost\b|\b(start|run|launch|serve)\s+(the\s+|it\s+|this\s+)?(web\s*)?(app|application|server|api|site|backend|frontend)\b|\bin the background\b|\b(server|api|endpoint)\s+(responds|returns|works)\b|serverni (ishga tushir|yurgiz)|запусти (сервер|приложение)/i;

const WEB =
  /(^|\s)@web\b|https?:\/\/|\bsearch(ing)? (the )?(web|internet)\b(?! ?(page|app|site|form|ui))|\b(search|look(ing)? up|google|find|check)\b[^.\n]{0,40}\b(online|on the (web|internet))\b|\b(latest|newest|current)\s+(stable\s+)?(version|release)\b|\bofficial (docs|documentation)\b|\bchangelog\b|internetdan|internetda|в интернете|последн\w* верси/i;

const MEMORY = /\bremember\b|\bfrom now on\b|\bnext time\b|\bkeep in mind\b|\bmemori[sz]e\b|eslab qol|esda tut|bundan keyin|запомни|впредь/i;

/**
 * Optional tool groups a todo needs, decided from its text without the model:
 * every extra tool in the action schema is another wrong choice for a small model.
 */
/** A file path or file name (`src/a.ts`, `Program.cs`) in the text. */
const NAMES_FILE = /[\w-]+\.(ts|tsx|js|jsx|mjs|cjs|py|cs|go|java|rs|rb|php|cpp|c|h|hpp|kt|swift|json|ya?ml|md|html|css|scss|sql|csproj|sln)\b|[\w.-]+\/[\w./-]+/i;

export function toolNeeds(todo: string, message = "", opts: { largeRepo?: boolean } = {}): Set<ToolGroup> {
  const needs = new Set<ToolGroup>();
  // Web access is the user's call: their message (@web, a URL, "search online") counts, not just the todo.
  if (WEB.test(todo) || WEB.test(message)) needs.add("web");
  if (GIT.test(todo)) needs.add("git");
  if (FILE_OPS.test(todo)) needs.add("fileops");
  if (REFACTOR.test(todo)) needs.add("refactor");
  if (PROCESS.test(todo)) needs.add("process");
  if (MEMORY.test(todo) || MEMORY.test(message)) needs.add("memory");
  // Finding the place to change in a big repo takes many reads; a sub-agent keeps them out of this history.
  if (opts.largeRepo && !NAMES_FILE.test(todo) && !NAMES_FILE.test(message)) needs.add("explore");
  return needs;
}

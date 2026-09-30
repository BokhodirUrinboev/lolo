import type { FileChange } from "../host/types";
import { detectEol } from "../edit/text";

/**
 * Missing `using` directives, added by code like an IDE quick fix. A build that fails with
 * "The name 'Regex' does not exist in the current context" is trivial to fix, but a 7B
 * model adding the line tends to replace a method signature with a second copy of the
 * class, and then gets stuck. Only well-known framework types (no NuGet packages).
 */
const CS_NAMESPACES: Record<string, string> = {};
const add = (ns: string, names: string) => names.split(" ").forEach((n) => (CS_NAMESPACES[n] = ns));
add("System.Text.RegularExpressions", "Regex RegexOptions Match MatchCollection Group");
add("System.Text", "StringBuilder Encoding");
add("System.Text.Json", "JsonSerializer JsonSerializerOptions JsonDocument JsonElement JsonException JsonNamingPolicy");
add("System.Text.Json.Serialization", "JsonPropertyName JsonIgnore JsonConverter JsonStringEnumConverter");
add("System.Globalization", "CultureInfo NumberStyles DateTimeStyles");
add("System.Diagnostics", "Stopwatch Debug Process Trace");
add("System.Collections.Concurrent", "ConcurrentDictionary ConcurrentQueue ConcurrentBag ConcurrentStack BlockingCollection");
add("System.Collections.Immutable", "ImmutableArray ImmutableList ImmutableDictionary ImmutableHashSet");
add("System.Collections.ObjectModel", "ObservableCollection ReadOnlyCollection ReadOnlyDictionary Collection");
add("System.Collections.Generic", "List Dictionary HashSet Queue Stack SortedDictionary SortedSet LinkedList KeyValuePair IEnumerable IList IDictionary IReadOnlyList IReadOnlyDictionary IReadOnlyCollection ICollection IComparer IEqualityComparer");
add("System.Linq", "Enumerable IGrouping ILookup IOrderedEnumerable");
add("System.IO", "File Path Directory FileInfo DirectoryInfo Stream StreamReader StreamWriter MemoryStream FileStream TextReader TextWriter StringReader StringWriter IOException FileNotFoundException");
add("System.Threading", "CancellationToken CancellationTokenSource Interlocked SemaphoreSlim Mutex Monitor Thread Timer");
add("System.Threading.Tasks", "Task ValueTask Parallel TaskCompletionSource");
add("System.Threading.Channels", "Channel ChannelReader ChannelWriter");
add("System.Security.Cryptography", "SHA256 SHA1 SHA512 MD5 RandomNumberGenerator HMACSHA256 Aes");
add("System.Numerics", "BigInteger Complex Vector2 Vector3");
add("System.ComponentModel.DataAnnotations", "Required Range StringLength MaxLength MinLength EmailAddress RegularExpression Key");
add("System.Net", "IPAddress Dns HttpStatusCode WebUtility");
add("System.Net.Http", "HttpClient HttpResponseMessage HttpRequestMessage HttpMethod");
add("System.Xml.Linq", "XDocument XElement XAttribute");

/** `file(line,col): error CS0103: The name 'Regex' does not exist ...` / `error CS0246: The type or namespace name 'List<>' could not be found`. */
const CS_ERROR = /^\s*(.+?\.cs)\(\d+,\d+\): error CS(?:0103|0246): The (?:type or namespace )?name '([A-Za-z_]\w*)(?:<[^']*>)?'/gm;

/** Workspace-relative POSIX path, or undefined when `file` is outside `root`. */
export function workspacePath(file: string, root: string): string | undefined {
  const f = file.replace(/\\/g, "/");
  const r = root.replace(/\\/g, "/").replace(/\/$/, "");
  const abs = /^([a-zA-Z]:)?\//.test(f);
  if (!abs) return f.replace(/^\.\//, "");
  const insensitive = /^[a-zA-Z]:/.test(r);
  const prefix = r + "/";
  const matches = insensitive ? f.toLowerCase().startsWith(prefix.toLowerCase()) : f.startsWith(prefix);
  return matches ? f.slice(prefix.length) : undefined;
}

/** `content` with `using <ns>;` after its last using directive, or at the top. */
export function addUsing(content: string, ns: string): string {
  const eol = detectEol(content);
  const bom = content.startsWith("﻿") ? "﻿" : "";
  const lines = content.slice(bom.length).split(/\r?\n/);
  const using = /^\s*(global\s+)?using\s+(static\s+)?[\w.]+(\s*=\s*[\w.<>]+)?\s*;/;
  if (lines.some((l) => new RegExp(`^\\s*(global\\s+)?using\\s+${ns.replace(/\./g, "\\.")}\\s*;`).test(l))) return content;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (using.test(lines[i])) last = i;
    else if (lines[i].trim() && !/^\s*(\/\/|#)/.test(lines[i])) break; // first code line: usings come before it
  }
  if (last >= 0) lines.splice(last + 1, 0, `using ${ns};`);
  else lines.splice(0, 0, `using ${ns};`, ...(lines[0]?.trim() ? [""] : []));
  return bom + lines.join(eol);
}

/**
 * Fixes for C# build output: the missing using directives per file, as new file contents,
 * and a note for the model. Empty when the output has none of the known types.
 */
export async function missingUsings(output: string, root: string, read: (path: string) => Promise<string>): Promise<{ changes: FileChange[]; note: string }> {
  const wanted = new Map<string, Set<string>>();
  for (const m of output.matchAll(CS_ERROR)) {
    const ns = CS_NAMESPACES[m[2]];
    const file = workspacePath(m[1].trim(), root);
    if (!ns || !file) continue;
    wanted.set(file, (wanted.get(file) ?? new Set()).add(ns));
  }
  const changes: FileChange[] = [];
  const notes: string[] = [];
  for (const [file, namespaces] of wanted) {
    const before = await read(file).catch(() => undefined);
    if (before === undefined) continue;
    let after = before;
    for (const ns of namespaces) after = addUsing(after, ns);
    if (after === before) continue;
    changes.push({ path: file, content: after });
    notes.push(`${[...namespaces].map((n) => `\`using ${n};\``).join(", ")} to ${file}`);
  }
  return { changes, note: notes.length ? `Added the missing ${notes.join("; ")}.` : "" };
}

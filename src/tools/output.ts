const ERROR_LINE = /\b(error|errors|fail(ed|ure)?|exception|panic|traceback|cannot|undefined reference|not found)\b|✗|✘|FAIL\b|\bE\d{3,}\b|\bCS\d{4}\b|\bTS\d{4}\b/i;

/**
 * Shortens long command output to head + tail, keeping error lines from the
 * middle in full: they are what the repair step needs.
 */
export function truncateOutput(text: string, maxLines = 120): string {
  const lines = text.replace(/\r\n/g, "\n").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split("\n");
  if (lines.length <= maxLines) return lines.join("\n");
  const head = Math.floor(maxLines * 0.3);
  const tail = Math.floor(maxLines * 0.45);
  const middle = lines.slice(head, lines.length - tail);
  const errors = middle.filter((l) => ERROR_LINE.test(l)).slice(0, maxLines - head - tail);
  const omitted = middle.length - errors.length;
  return [
    ...lines.slice(0, head),
    `... [${omitted} lines omitted${errors.length ? `; ${errors.length} error lines kept below` : ""}] ...`,
    ...errors,
    ...(errors.length ? ["..."] : []),
    ...lines.slice(lines.length - tail),
  ].join("\n");
}

/** Cheap symbol summary for compaction notes, e.g. "class UserService, fn getById". */
export function symbolSummary(text: string, max = 5): string {
  const names: string[] = [];
  const re = /\b(class|interface|enum|struct|record|trait|function|def|func|fn)\s+([A-Za-z_]\w*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && names.length < max) names.push(`${m[1]} ${m[2]}`);
  return names.join(", ");
}

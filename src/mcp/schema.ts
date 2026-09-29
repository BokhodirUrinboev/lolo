import type { Schema } from "../tools/validate";

/**
 * MCP tool input schemas → the subset that Ollama's `format` (llama.cpp grammar)
 * and tools/validate.ts both understand: $refs inlined, oneOf → anyOf, allOf
 * merged, nullable types made optional, unsupported keywords (pattern, format,
 * patternProperties, if/then, ...) dropped.
 */

const MAX_DEPTH = 8;
const TYPES = new Set(["object", "string", "integer", "number", "boolean", "array"]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export function sanitizeSchema(input: Json): Schema & { type: "object" } {
  const defs = { ...(input?.definitions ?? {}), ...(input?.$defs ?? {}) };
  const out = convert(input ?? {}, defs, 0, new Set());
  if (out.type !== "object") return { type: "object", properties: {} };
  return out as Schema & { type: "object" };
}

function convert(s: Json, defs: Record<string, Json>, depth: number, refs: Set<string>): Schema {
  if (!s || typeof s !== "object" || depth > MAX_DEPTH) return {};
  if (typeof s.$ref === "string") {
    const name = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(s.$ref)?.[1];
    if (!name || !defs[name] || refs.has(name)) return {}; // external or recursive: accept anything
    return convert(defs[name], defs, depth + 1, new Set([...refs, name]));
  }
  const alts = s.anyOf ?? s.oneOf;
  if (Array.isArray(alts)) {
    const branches = alts.filter((b: Json) => b?.type !== "null").map((b: Json) => convert(b, defs, depth + 1, refs));
    if (branches.length === 1) return withDescription(branches[0], s);
    return withDescription({ anyOf: branches }, s);
  }
  if (Array.isArray(s.allOf)) {
    const merged: Json = { type: "object", properties: {}, required: [] };
    for (const part of s.allOf.map((p: Json) => convert(p, defs, depth + 1, refs))) {
      if (part.type && part.type !== "object") return withDescription(part, s);
      Object.assign(merged.properties, part.properties ?? {});
      merged.required.push(...(part.required ?? []));
    }
    return withDescription(merged, s);
  }

  let type = s.type;
  if (Array.isArray(type)) type = type.find((t: string) => t !== "null"); // nullable → just optional
  if (!type) {
    if (s.properties) type = "object";
    else if (s.items) type = "array";
  }
  const out: Schema = {};
  if (TYPES.has(type)) out.type = type;
  if (Array.isArray(s.enum)) out.enum = s.enum.filter((v: unknown) => v !== null);
  if (s.const !== undefined) out.const = s.const;
  if (out.type === "object") {
    out.properties = {};
    for (const [k, v] of Object.entries(s.properties ?? {})) out.properties[k] = convert(v, defs, depth + 1, refs);
    const required = (Array.isArray(s.required) ? s.required : []).filter((k: string) => k in out.properties!);
    if (required.length) out.required = required;
  }
  if (out.type === "array") {
    const items = Array.isArray(s.items) ? s.items[0] : s.items;
    if (items) out.items = convert(items, defs, depth + 1, refs);
    if (typeof s.minItems === "number") out.minItems = s.minItems;
    if (typeof s.maxItems === "number") out.maxItems = s.maxItems;
  }
  if (out.type === "integer" || out.type === "number") {
    if (typeof s.minimum === "number") out.minimum = s.minimum;
    if (typeof s.maximum === "number") out.maximum = s.maximum;
  }
  if (out.type === "string" && typeof s.minLength === "number") out.minLength = s.minLength;
  return withDescription(out, s);
}

function withDescription(out: Schema, s: Json): Schema {
  if (typeof s.description === "string" && s.description.trim()) out.description = shorten(s.description, 120);
  return out;
}

export function shorten(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sentence = cut.lastIndexOf(". ");
  return sentence > max / 2 ? cut.slice(0, sentence + 1) : cut.slice(0, max - 1) + "…";
}

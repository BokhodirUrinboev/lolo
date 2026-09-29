/**
 * Minimal JSON Schema validator for the subset tool schemas use: object/string/
 * integer/number/boolean/array, properties, required, enum, const, min/max.
 * Constrained decoding should already guarantee shape; this is the backstop and
 * produces error text the model can act on.
 */
export interface Schema {
  type?: "object" | "string" | "integer" | "number" | "boolean" | "array";
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  /** Also passed to constrained decoding: caps runaway strings (a `thought` that never ends). */
  maxLength?: number;
  anyOf?: Schema[];
}

export function validate(value: unknown, schema: Schema, path = "args"): string[] {
  const errors: string[] = [];
  if (schema.anyOf) {
    const branches = schema.anyOf.map((s) => validate(value, s, path));
    if (branches.every((e) => e.length)) errors.push(`${path}: does not match any allowed form`);
    return errors;
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return [`${path}: must be an object`];
      const obj = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (obj[key] === undefined || obj[key] === null) errors.push(`${path}.${key}: is required`);
      }
      for (const [key, v] of Object.entries(obj)) {
        const sub = schema.properties?.[key];
        if (sub) {
          if (v !== undefined && v !== null) errors.push(...validate(v, sub, `${path}.${key}`));
        } else if (schema.additionalProperties === false) {
          errors.push(`${path}.${key}: unknown field`);
        }
      }
      break;
    }
    case "string":
      if (typeof value !== "string") errors.push(`${path}: must be a string`);
      else if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: must not be empty`);
      break;
    case "integer":
    case "number":
      if (typeof value !== "number" || (schema.type === "integer" && !Number.isInteger(value))) {
        errors.push(`${path}: must be ${schema.type === "integer" ? "an integer" : "a number"}`);
      } else {
        if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: must be ≥ ${schema.minimum}`);
        if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: must be ≤ ${schema.maximum}`);
      }
      break;
    case "boolean":
      if (typeof value !== "boolean") errors.push(`${path}: must be a boolean`);
      break;
    case "array":
      if (!Array.isArray(value)) return [`${path}: must be an array`];
      if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: needs at least ${schema.minItems} items`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: allows at most ${schema.maxItems} items`);
      if (schema.items) value.forEach((v, i) => errors.push(...validate(v, schema.items!, `${path}[${i}]`)));
      break;
  }
  return errors;
}

// The small part of JSON Schema the published schemas use. Written here because every dependency is
// part of the supply chain the host inherits, and this is under a hundred lines.

export type JsonSchema = Record<string, any>;

export interface SchemaError {
  path: string;
  keyword: string;
  message: string;
}

export function escapePointer(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function typeMatches(actual: string, expected: string): boolean {
  return actual === expected || (expected === "number" && actual === "integer");
}

export function checkSchema(schema: JsonSchema, value: unknown, path = "", root: JsonSchema = schema): SchemaError[] {
  if (schema.$ref) {
    const name = String(schema.$ref).replace("#/$defs/", "");
    return checkSchema(root.$defs[name], value, path, root);
  }
  const fail = (keyword: string, message: string): SchemaError[] => [{ path, keyword, message }];
  const actual = typeOf(value);
  if (schema.type !== undefined) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(actual, t))) return fail("type", `${path || "The document"} must be ${types.join(" or ")}.`);
  }
  if (schema.const !== undefined && value !== schema.const) return fail("const", `${path} must be ${JSON.stringify(schema.const)}.`);
  if (schema.enum && !schema.enum.includes(value)) return fail("enum", `${path} must be one of ${schema.enum.join(", ")}.`);
  const errors: SchemaError[] = [];
  if (typeof value === "string") {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) errors.push({ path, keyword: "minLength", message: `${path} must have at least ${schema.minLength} characters.` });
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) errors.push({ path, keyword: "maxLength", message: `${path} must have at most ${schema.maxLength} characters.` });
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) errors.push({ path, keyword: "pattern", message: schema.patternMessage ?? `${path} must match ${schema.pattern}.` });
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path, keyword: "minimum", message: `${path} must be at least ${schema.minimum}.` });
    if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path, keyword: "maximum", message: `${path} must be at most ${schema.maximum}.` });
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push({ path, keyword: "exclusiveMinimum", message: `${path} must be more than ${schema.exclusiveMinimum}.` });
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push({ path, keyword: "minItems", message: `${path} must have at least ${schema.minItems} entries.` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push({ path, keyword: "maxItems", message: `${path} must have at most ${schema.maxItems} entries.` });
    if (schema.items) value.forEach((item, i) => errors.push(...checkSchema(schema.items, item, `${path}/${i}`, root)));
  }
  if (actual === "object") {
    const object = value as Record<string, unknown>;
    for (const name of schema.required ?? []) {
      if (!(name in object)) errors.push({ path: `${path}/${escapePointer(name)}`, keyword: "required", message: `${path || "The document"} needs the field ${name}.` });
    }
    for (const [name, item] of Object.entries(object)) {
      const child = `${path}/${escapePointer(name)}`;
      const sub = schema.properties && Object.hasOwn(schema.properties, name) ? schema.properties[name] : undefined;
      if (sub) errors.push(...checkSchema(sub, item, child, root));
      else if (schema.additionalProperties === false) errors.push({ path: child, keyword: "additionalProperties", message: `${name} is not a field here.` });
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") errors.push(...checkSchema(schema.additionalProperties, item, child, root));
    }
  }
  if (schema.oneOf) {
    const branches = (schema.oneOf as JsonSchema[]).map((s) => checkSchema(s, value, path, root));
    const passing = branches.filter((b) => b.length === 0).length;
    if (passing !== 1) {
      // Report the branch that got furthest, which is the one whose `type` matched.
      const best = branches.reduce((a, b) => (constFailed(a) && !constFailed(b) ? b : a));
      errors.push(...(passing === 0 ? best : [{ path, keyword: "oneOf", message: `${path} matches several alternatives.` }]));
    }
  }
  return errors;
}

function constFailed(errors: SchemaError[]): boolean {
  return errors.some((e) => e.keyword === "const");
}

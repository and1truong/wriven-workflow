// JSON Pointer (RFC 6901) lookups and the two kinds of field reference a pipeline can make.

export function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  return pointer
    .slice(1)
    .split("/")
    .map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
}

export const POINTER_PATTERN = "^(/([^~/]|~0|~1)*)+$";

export function isPointer(text: string): boolean {
  return new RegExp(POINTER_PATTERN).test(text);
}

export type Lookup = { found: true; value: unknown } | { found: false };

export function pointerGet(data: unknown, pointer: string): Lookup {
  let current = data;
  for (const token of parsePointer(pointer)) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token) || Number(token) >= current.length) return { found: false };
      current = current[Number(token)];
    } else if (current !== null && typeof current === "object" && Object.hasOwn(current, token)) {
      current = (current as Record<string, unknown>)[token];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

// Returns false when the parent does not exist or cannot hold the field.
export function pointerSet(data: unknown, pointer: string, value: unknown): boolean {
  const tokens = parsePointer(pointer);
  const last = tokens.pop();
  if (last === undefined) return false;
  const parent = pointerGet(data, tokens.length === 0 ? "" : `/${tokens.map((t) => t.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`);
  if (!parent.found || parent.value === null || typeof parent.value !== "object") return false;
  if (Array.isArray(parent.value)) {
    if (!/^(0|[1-9][0-9]*)$/.test(last) || Number(last) > parent.value.length) return false;
    parent.value[Number(last)] = value;
    return true;
  }
  (parent.value as Record<string, unknown>)[last] = value;
  return true;
}

export interface Placeholder {
  raw: string;
  // A JSON Pointer into data, or a metadata key.
  pointer?: string;
  meta?: string;
}

// Every {{…}} in a template. Anything that is not a pointer or meta:key is `invalid`.
export function findPlaceholders(text: string): { placeholders: Placeholder[]; invalid: string[] } {
  const placeholders: Placeholder[] = [];
  const invalid: string[] = [];
  for (const match of text.matchAll(/\{\{([^{}]*)\}\}/g)) {
    const inner = match[1]!;
    if (inner.startsWith("meta:") && inner.length > 5) placeholders.push({ raw: match[0], meta: inner.slice(5) });
    else if (isPointer(inner)) placeholders.push({ raw: match[0], pointer: inner });
    else invalid.push(match[0]);
  }
  return { placeholders, invalid };
}

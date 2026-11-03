// Fits a JSON result under a size limit without breaking its structure: the largest strings become
// { preview, original_size, truncated }, then arrays lose their tails. Pipelines are never truncated.

const PREVIEW_CHARS = 2048;
const PROTECTED_KEYS = new Set(["pipeline", "previous_pipeline"]);

type Holder = { parent: any; key: string | number };

function collect(value: any, strings: Holder[], arrays: Holder[], parent: any, key: string | number): void {
  if (typeof value === "string") {
    strings.push({ parent, key });
  } else if (Array.isArray(value)) {
    arrays.push({ parent, key });
    value.forEach((item, i) => collect(item, strings, arrays, value, i));
  } else if (value !== null && typeof value === "object") {
    if (value.truncated === true && typeof value.preview === "string") return;
    for (const [k, v] of Object.entries(value)) {
      if (!PROTECTED_KEYS.has(k)) collect(v, strings, arrays, value, k);
    }
  }
}

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

export function truncateResult<T>(input: T, limit: number): T {
  if (size(input) <= limit) return input;
  const root = { value: structuredClone(input) as any };
  const strings: Holder[] = [];
  const arrays: Holder[] = [];
  collect(root.value, strings, arrays, root, "value");

  strings.sort((a, b) => b.parent[b.key].length - a.parent[a.key].length);
  let total = size(root.value);
  for (const { parent, key } of strings) {
    if (total <= limit) break;
    const text: string = parent[key];
    if (text.length <= PREVIEW_CHARS) break;
    const replacement = { preview: text.slice(0, PREVIEW_CHARS), original_size: Buffer.byteLength(text), truncated: true };
    parent[key] = replacement;
    total -= size(text) - size(replacement);
  }

  // Longest serialized array first; each loses its tail, a share at a time, until the whole fits.
  for (let over = size(root.value) - limit; over > 0; over = size(root.value) - limit) {
    const live = arrays.map(({ parent, key }) => parent[key]).filter((a) => Array.isArray(a) && a.some((item: any) => !isMarker(item)));
    if (live.length === 0) break;
    const largest: any[] = live.reduce((a, b) => (size(b) > size(a) ? b : a));
    const marker = isMarker(largest.at(-1)) ? largest.pop() : { truncated: true, omitted: 0 };
    const share = Math.max(1, Math.ceil((largest.length * over) / size(largest)));
    const removed = largest.splice(Math.max(0, largest.length - share));
    marker.omitted += removed.length;
    largest.push(marker);
  }

  if (root.value !== null && typeof root.value === "object" && !Array.isArray(root.value)) root.value.truncated = true;
  return root.value as T;
}

function isMarker(item: any): boolean {
  return item?.truncated === true && typeof item.omitted === "number";
}

// `wriven-workflow validate <file>`: human and CI use. Accepts JSON or YAML, or "-" for JSON on stdin,
// and prints the validation result and permissions as JSON.

import { parseArgs } from "node:util";
import { DEFAULT_VALIDATION_CONTEXT, validatePipeline } from "./validate.ts";

export async function loadDocument(path: string): Promise<unknown> {
  const text = path === "-" ? await Bun.stdin.text() : await Bun.file(path).text();
  return /\.ya?ml$/.test(path) ? Bun.YAML.parse(text) : JSON.parse(text);
}

export async function validateMain(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { clock: { type: "string", default: "engine" }, "display-name": { type: "string" } },
  });
  const path = positionals[0];
  if (!path) {
    console.error("usage: wriven-workflow validate <file> [--clock host|engine] [--display-name <name>]");
    return 2;
  }
  let document: unknown;
  try {
    document = await loadDocument(path);
  } catch (err) {
    console.error(`Could not read ${path}: ${(err as Error).message}`);
    return 2;
  }
  const result = validatePipeline(document, {
    ...DEFAULT_VALIDATION_CONTEXT,
    clock: values.clock === "host" ? "host" : "engine",
    displayName: values["display-name"] ?? DEFAULT_VALIDATION_CONTEXT.displayName,
    sandboxAvailable: Bun.which("sandbox-exec") !== null,
  });
  console.log(JSON.stringify(result, null, 2));
  return result.valid ? 0 : 1;
}

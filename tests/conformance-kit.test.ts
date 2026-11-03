import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runConformance } from "../src/harness/conformance.ts";
import { ERROR_CODES } from "../src/protocol/errors.ts";
import { TOOLS } from "../src/tools/tools.ts";
import { BINARY, CONFORMANCE_DIR, descendants, isAlive, REPO, startHost, stateDir } from "./helpers.ts";

const SPEC = readFileSync(join(REPO, ".agents/specs/host-protocol.md"), "utf8");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("the conformance fixtures", () => {
  test("all ten, 10/10 against the binary", async () => {
    const results = await runConformance(CONFORMANCE_DIR, [BINARY]);
    expect(results.filter((r) => !r.passed)).toEqual([]);
    expect(results.length).toBe(10);
  }, 120_000);

  test("fake-host --conformance reports it and exits 0", () => {
    const out = Bun.spawnSync([BINARY, "fake-host", "--conformance", CONFORMANCE_DIR, "--engine", BINARY], { stdout: "pipe", stderr: "pipe" });
    expect(out.stdout.toString()).toContain("10/10 scenarios passed");
    expect(out.exitCode).toBe(0);
  }, 120_000);

  test("each scenario in the spec has a file", () => {
    const files = readdirSync(CONFORMANCE_DIR).filter((f) => f.endsWith(".json")).sort();
    expect(files.map((f) => f.slice(0, 2))).toEqual(["01", "02", "03", "04", "05", "06", "07", "08", "09", "10"]);
    for (const file of files) expect(readFileSync(join(CONFORMANCE_DIR, "README.md"), "utf8")).toContain(file.replace(".json", ""));
  });
});

describe("the error vocabulary", () => {
  const specRows = [...SPEC.matchAll(/^\| `([a-z_]+)` \| (-\d+) \|/gm)].map((m) => [m[1]!, Number(m[2])] as const);

  test("the table in the spec and the table in the code are the same", () => {
    expect(Object.fromEntries(specRows)).toEqual(ERROR_CODES);
  });

  test("every kind the source can emit is in the spec", () => {
    const reportOnly = /A report's `error.kind` may also be one of these[^\n]*/.exec(SPEC)![0];
    const documented = new Set([...specRows.map(([kind]) => kind), ...[...reportOnly.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!)]);
    const emitted = new Set<string>();
    for (const file of sourceFiles(join(REPO, "src"))) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/new (?:RpcError|StepError)\(\s*"([a-z_]+)"/g)) emitted.add(m[1]!);
      for (const m of text.matchAll(/errorOf\(\s*"([a-z_]+)"/g)) emitted.add(m[1]!);
      for (const m of text.matchAll(/kind: "([a-z_]+)",\s*\n?\s*message/g)) emitted.add(m[1]!);
    }
    expect([...emitted].filter((kind) => !documented.has(kind))).toEqual([]);
    expect(emitted.size).toBeGreaterThan(15);
  });

  test("every error over the wire carries a kind", async () => {
    const { host } = await startHost();
    host.sendRaw("{not json");
    for (const [method, params] of [
      ["no.such.method", {}],
      ["stream.get", {}],
      ["stream.get", { stream_id: "nope" }],
      ["stream.create", { pipeline: {} }],
      ["run.cancel", { run_id: "nope" }],
      ["pipeline.test", { pipeline: {} }],
      ["schedule.preview", {}],
    ] as const) {
      await host.request(method, params);
    }
    const errors = host.received.filter((m) => m.error);
    expect(errors.length).toBeGreaterThanOrEqual(8);
    for (const { error } of errors) {
      expect(ERROR_CODES[error.data.kind as keyof typeof ERROR_CODES]).toBe(error.code);
      expect(error.message.length).toBeGreaterThan(0);
    }
  });
});

describe("tools fit all three providers", () => {
  const ALLOWED_KEYS = new Set(["type", "properties", "required", "description", "enum", "items"]);
  const TYPES = new Set(["object", "string", "number", "integer", "boolean", "array"]);

  function checkNode(schema: any, depth: number, where: string): string[] {
    const problems: string[] = [];
    if (depth > 3) problems.push(`${where} nests deeper than three`);
    for (const key of Object.keys(schema)) if (!ALLOWED_KEYS.has(key)) problems.push(`${where} uses ${key}`);
    if (!TYPES.has(schema.type)) problems.push(`${where} has type ${schema.type}`);
    if (schema.enum && !schema.enum.every((v: unknown) => typeof v === "string")) problems.push(`${where} has a non-string enum`);
    if (depth > 0 && typeof schema.description !== "string") problems.push(`${where} has no description`);
    for (const [name, child] of Object.entries(schema.properties ?? {})) problems.push(...checkNode(child, depth + 1, `${where}/${name}`));
    if (schema.items) problems.push(...checkNode(schema.items, depth + 1, `${where}/items`));
    return problems;
  }

  const encodings: Record<string, (tool: (typeof TOOLS)[number]) => { name: string; schema: any }> = {
    anthropic: (t) => {
      const encoded = { name: t.name, description: t.description, input_schema: t.input_schema, strict: false };
      return { name: encoded.name, schema: encoded.input_schema };
    },
    gemini: (t) => {
      const encoded = { functionDeclarations: [{ name: t.name, description: t.description, parameters: t.input_schema }] };
      return { name: encoded.functionDeclarations[0]!.name, schema: encoded.functionDeclarations[0]!.parameters };
    },
    openrouter: (t) => {
      const encoded = { type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } };
      return { name: encoded.function.name, schema: encoded.function.parameters };
    },
  };

  test("there are eleven, named as the spec names them", () => {
    const spec = readFileSync(join(REPO, ".agents/specs/agent-surface.md"), "utf8");
    const named = [...spec.matchAll(/^\| `(workflow_[a-z_]+)` \| `([a-z.]+)` \|/gm)].map((m) => [m[1], m[2]]);
    expect(TOOLS.map((t) => [t.name, t.method])).toEqual(named as Array<[string, string]>);
    expect(TOOLS.length).toBe(11);
  });

  for (const [provider, encode] of Object.entries(encodings)) {
    for (const tool of TOOLS) {
      test(`${provider}: ${tool.name}`, () => {
        const { name, schema } = encode(tool);
        expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
        expect(schema.type).toBe("object");
        expect(Array.isArray(schema.required)).toBe(true);
        for (const required of schema.required) expect(Object.keys(schema.properties)).toContain(required);
        expect(checkNode(schema, 0, tool.name)).toEqual([]);
        expect(tool.description.length).toBeGreaterThan(20);
      });
    }
  }

  test("the method named by every tool answers without method_not_found, and pipeline stays a plain object", async () => {
    const { host } = await startHost();
    for (const tool of TOOLS) {
      const response = await host.request(tool.method, {});
      expect(response.error?.data.kind).not.toBe("method_not_found");
    }
    const pipeline = TOOLS.find((t) => t.name === "workflow_create_stream")!.input_schema.properties.pipeline;
    expect(Object.keys(pipeline).sort()).toEqual(["description", "type"]);
  });
});

describe("threat model", () => {
  test("killing the host mid-run leaves no engine or run process", async () => {
    const dir = stateDir();
    const host = Bun.spawn(["bun", join(REPO, "tests/support/dying-host.ts"), BINARY, dir], { stdout: "pipe", stderr: "inherit" });
    const reader = (host.stdout as ReadableStream<Uint8Array>).getReader();
    const { value } = await reader.read();
    const enginePid = Number(new TextDecoder().decode(value).trim());
    expect(enginePid).toBeGreaterThan(0);
    const children = descendants(enginePid);
    expect(children.length).toBe(1);
    host.kill("SIGKILL");
    await host.exited;
    const deadline = Date.now() + 11_000;
    while (Date.now() < deadline && (isAlive(enginePid) || children.some(isAlive))) await Bun.sleep(50);
    expect(isAlive(enginePid)).toBe(false);
    expect(children.some(isAlive)).toBe(false);
  }, 30_000);

  test("a run-tmp left by a dead engine is cleared at initialize", async () => {
    const { host, dir } = await startHost();
    host.closeStdin();
    await host.exited;
    const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
    mkdirSync(join(dir, "run-tmp", "old"), { recursive: true });
    writeFileSync(join(dir, "run-tmp", "old", "x"), "x");
    const { spawnHost, initParams } = await import("./helpers.ts");
    const again = spawnHost();
    await again.call("initialize", initParams(dir));
    expect(existsSync(join(dir, "run-tmp"))).toBe(false);
  });
});

describe("logs", () => {
  test("stderr carries JSON; log notifications mirror it", async () => {
    const { host } = await startHost({ init: { sandbox: "optional" } });
    await host.waitFor((m) => m.method === "log");
    host.closeStdin();
    await host.exited;
    await Bun.sleep(50);
    expect(host.stderr.length).toBeGreaterThan(0);
    for (const line of host.stderr) {
      const entry = JSON.parse(line);
      expect(typeof entry.level).toBe("string");
      expect(typeof entry.time).toBe("string");
      expect(typeof entry.msg).toBe("string");
    }
    expect(host.notifications("log").map((n) => n.params.msg)).toContain("engine initialized");
  });
});

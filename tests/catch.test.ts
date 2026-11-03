import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_VALIDATION_CONTEXT, validatePipeline, type ValidationContext } from "../src/pipeline/validate.ts";
import { REPO, startHost } from "./helpers.ts";

const EXAMPLE = JSON.parse(readFileSync(join(REPO, "fixtures/pipelines/valid/feed-digest.json"), "utf8"));
const FIXTURES = EXAMPLE.tests[0].fixtures;
const URLS: string[] = EXAMPLE.processors[0].urls;
const DOWN = { ...FIXTURES, [URLS[2]!]: { status: 503, body: "down" } };
const WORKED = JSON.parse(readFileSync(join(REPO, "fixtures/pipelines/valid/composition-digest.json"), "utf8"));
const WRIVEN: ValidationContext = { ...DEFAULT_VALIDATION_CONTEXT, clock: "host", displayName: "Wriven", sandboxAvailable: true };

const pipeline = (catchSteps: unknown[]) => ({
  format: "wriven-workflow/pipeline@1",
  name: "Notes",
  input: { type: "host_trigger" },
  processors: [
    {
      id: "sources",
      type: "try",
      steps: [
        { id: "fetch", type: "http_fetch", urls: URLS },
        { id: "parse", type: "parse_feed" },
      ],
      catch: catchSteps,
    },
    { id: "say", type: "template", target: "/out", text: "{{/title}} | {{meta:error_step}} | {{meta:source_url}}", missing: "empty" },
  ],
  output: { type: "host_result", title: "Entry", body: "/out" },
  limits: { llm_calls_per_run: 0, runs_per_day: 2, run_timeout: "5m" },
});

const note = { id: "failure_note", type: "template", target: "/title", text: "Could not read {{meta:source_url}}: {{meta:error_code}}" };

describe("catch", () => {
  test("the failed unit goes through catch with its error, after the steps' output", async () => {
    const { host } = await startHost();
    const result = await host.call("pipeline.test", { pipeline: pipeline([note]), fixtures: DOWN });
    expect(result.status).toBe("succeeded");
    const bodies: string[] = result.results.map((r: any) => r.body);
    expect(bodies.at(-1)).toBe(`Could not read ${URLS[2]}: http_status | fetch | ${URLS[2]}`);
    expect(bodies.slice(0, -1).every((b) => !b.startsWith("Could not read"))).toBe(true);
    expect(bodies.slice(0, -1)).toContain("Alpha a1 |  | https://example.com/feed.xml");
    expect(result.report.warnings).toMatchObject([{ step_id: "fetch", message_id: "m1.2", caught_by: "sources" }]);
  }, 30_000);

  test("permissions say failed items are handled with fallback steps", () => {
    const result = validatePipeline(pipeline([note]), DEFAULT_VALIDATION_CONTEXT);
    if (!result.valid) throw new Error(JSON.stringify(result.errors));
    expect(result.permissions.handles_failed_items).toBe(true);
    expect(result.permissions.skips_failed_items).toBe(false);
    expect(result.rendered).toContain("When an item fails at a step, handles it with fallback steps instead of stopping, and says so in the run report.");
  });

  test("a catch step that fails fails the run; a try inside catch handles it", async () => {
    const { host } = await startHost();
    // /body is on the fetched side only, so it validates; the unit that failed at fetch has none.
    const broken = { id: "broken", type: "template", target: "/title", text: "{{/body}}" };
    const failing = await host.call("pipeline.test", { pipeline: pipeline([broken]), fixtures: DOWN });
    expect(failing.status).toBe("failed");
    expect(failing.report.error).toMatchObject({ kind: "unresolved_pointer", step_id: "broken", message_id: "m1.2" });
    const guarded = await host.call("pipeline.test", { pipeline: pipeline([{ id: "inner", type: "try", catch: [], steps: [broken] }]), fixtures: DOWN });
    expect(guarded.status).toBe("succeeded");
    expect(guarded.report.warnings.map((w: any) => `${w.step_id}:${w.caught_by}`)).toEqual(["fetch:sources", "broken:inner"]);
  }, 30_000);

  test("catch validates against the shapes its unit can have", () => {
    const codes = (steps: unknown[]) => validatePipeline(pipeline(steps), DEFAULT_VALIDATION_CONTEXT).errors.map((e) => `${e.code} ${e.path}`);
    // The trigger message reaches fetch and a fetched page reaches parse: /run_id is on one side only.
    expect(codes([{ id: "n", type: "template", target: "/t", text: "{{/run_id}}" }])).toEqual([]);
    expect(codes([{ id: "n", type: "template", target: "/t", text: "{{/never_anywhere}}" }])).toEqual(["unresolved_pointer /processors/0/catch/0/text"]);
  });
});

describe("the composition worked example", () => {
  test("renders as the v0 example's sentences, with the handles sentence and 31 requests", () => {
    const { tests: _tests, ...document } = WORKED;
    const result = validatePipeline(document, WRIVEN);
    if (!result.valid) throw new Error(JSON.stringify(result.errors));
    expect(result.rendered).toEqual([
      "Runs: when Wriven asks.",
      "Fetches from: blog.example.org, example.com, news.example.net (GET only, over HTTPS).",
      "When an item fails at a step, handles it with fallback steps instead of stopping, and says so in the run report.",
      "Keeps: a list of items already seen, on this Mac, for 90 days (up to 10,000 items).",
      "Uses: the AI provider of this chat, at most 31 requests per run.",
      "Sends fetched web content to the AI provider.",
      "Writes results to: Wriven.",
      "Limits: at most 2 runs per day; each run stops after 5 minutes.",
      "Does not: run programs, read or write your files, listen for connections, send data anywhere not listed above, or hold any API key.",
      "OS sandbox: on (macOS Seatbelt).",
    ]);
  });

  test("its embedded tests pass, and the unreadable feed reaches the digest prompt", async () => {
    const { host } = await startHost();
    const embedded = await host.call("pipeline.test", { pipeline: WORKED, run_embedded: true });
    expect(embedded.tests.map((t: any) => [t.name, t.failures])).toEqual(WORKED.tests.map((t: any) => [t.name, []]));
    const { tests: _tests, ...document } = WORKED;
    const result = await host.call("pipeline.test", { pipeline: document, fixtures: DOWN, llm: { mode: "echo" } });
    expect(result.status).toBe("succeeded");
    expect(result.clamped).toEqual(["for_each:classify_each"]);
    const digest = result.llm_requests.at(-1);
    expect(digest.step_id).toBe("summarize");
    expect(digest.prompt).toContain(`Could not read ${URLS[2]} today`);
    expect(digest.prompt).toContain("Alpha a1");
    expect(digest.prompt).not.toContain("Gamma g1");
  }, 30_000);

  test("31 messages reaching classify_each use every call, so the digest fails with budget_exceeded", async () => {
    const { host } = await startHost();
    const item = (i: number) => `<item><guid>a${i}</guid><title>Alpha ${i}</title><link>https://example.com/${i}</link></item>`;
    const feed = (n: number, from: number) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Many</title>${Array.from({ length: n }, (_, i) => item(from + i)).join("")}</channel></rss>`;
    const fixtures = (counts: number[]) =>
      Object.fromEntries(URLS.map((u, i) => [u, { status: 200, content_type: "application/rss+xml", body: feed(counts[i]!, i * 100) }]));
    const { tests: _tests, ...document } = WORKED;
    const thirty = await host.call("pipeline.test", { pipeline: document, fixtures: fixtures([10, 10, 10]), llm: { mode: "mock", responses: ["news"] } });
    expect(thirty.status).toBe("succeeded");
    expect(thirty.report.llm.calls).toBe(31);
    const over = await host.call("pipeline.test", { pipeline: document, fixtures: fixtures([11, 10, 10]), llm: { mode: "mock", responses: ["news"] } });
    expect(over.status).toBe("failed");
    expect(over.report.error).toMatchObject({ kind: "budget_exceeded", step_id: "summarize" });
    expect(over.report.llm.calls).toBe(31);
  }, 60_000);
});

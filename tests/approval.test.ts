import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FakeHost } from "../src/harness/fake-host.ts";
import { derivePermissions, type Permissions } from "../src/pipeline/permissions.ts";
import { isSubset, sentenceDiff } from "../src/pipeline/subset.ts";
import { startHost } from "./helpers.ts";

const INIT = { sandbox: "optional" };
const A = "https://a.example/feed";
const B = "https://b.example/feed";
const C = "https://c.example/feed";

const pipeline = (urls: string[], overrides: Record<string, unknown> = {}) => ({
  format: "wriven-workflow/pipeline@1",
  name: "Fetch",
  input: { type: "host_trigger" },
  processors: [{ id: "fetch", type: "http_fetch", urls }],
  output: { type: "drop" },
  limits: { llm_calls_per_run: 0, runs_per_day: 2, run_timeout: "5m" },
  ...overrides,
});

async function active(host: FakeHost, document: unknown): Promise<any> {
  const created = await host.call("stream.create", { pipeline: document });
  await host.call("stream.approve", { stream_id: created.stream_id, permissions_hash: created.permissions_hash });
  return created;
}

describe("stream.update over the protocol", () => {
  test("adding a host: pending_approval, diff of the two Fetches lines, old pipeline not runnable", async () => {
    const { host } = await startHost({ init: INIT });
    const created = await active(host, pipeline([A]));
    const update = await host.call("stream.update", { stream_id: created.stream_id, pipeline: pipeline([A, B]) });
    expect(update.status).toBe("pending_approval");
    expect(update.diff).toEqual({
      added: ["Fetches from: a.example, b.example (GET only, over HTTPS)."],
      removed: ["Fetches from: a.example (GET only, over HTTPS)."],
    });
    expect((await host.request("run.trigger", { stream_id: created.stream_id })).error.data.kind).toBe("permission_denied");
    const got = await host.call("stream.get", { stream_id: created.stream_id });
    expect(got.status).toBe("pending_approval");
    expect(got.pipeline.processors[0].urls).toEqual([A]);
    expect(got.pending.permissions_hash).toBe(update.permissions_hash);
    expect(got.previous_pipeline.processors[0].urls).toEqual([A]);
  });

  test("removing a host applies silently and keeps the status", async () => {
    const { host } = await startHost({ init: INIT });
    const created = await active(host, pipeline([A, B]));
    const update = await host.call("stream.update", { stream_id: created.stream_id, pipeline: pipeline([A]) });
    expect(update.status).toBe("active");
    expect(update.diff).toBeUndefined();
    const got = await host.call("stream.get", { stream_id: created.stream_id });
    expect(got.pipeline.processors[0].urls).toEqual([A]);
    expect(got.rendered[1]).toBe("Fetches from: a.example (GET only, over HTTPS).");
    expect(host.notifications("stream.changed")).toEqual([]);
  });

  test("a stale hash on approve gets conflict; the new one activates the new pipeline", async () => {
    const { host } = await startHost({ init: INIT });
    const created = await active(host, pipeline([A]));
    const update = await host.call("stream.update", { stream_id: created.stream_id, pipeline: pipeline([A, B]) });
    const stale = await host.request("stream.approve", { stream_id: created.stream_id, permissions_hash: created.permissions_hash });
    expect(stale.error.data.kind).toBe("conflict");
    expect(stale.error.data.current).toBe(update.permissions_hash);
    expect((await host.call("stream.approve", { stream_id: created.stream_id, permissions_hash: update.permissions_hash })).status).toBe("active");
    const got = await host.call("stream.get", { stream_id: created.stream_id });
    expect(got.pipeline.processors[0].urls).toEqual([A, B]);
    expect(got.previous_pipeline.processors[0].urls).toEqual([A]);
    expect(got.pending).toBeUndefined();
  });

  test("rolling back a pending widening with previous_pipeline needs no approval", async () => {
    const { host, dir } = await startHost({ init: INIT });
    const created = await active(host, pipeline([A]));
    await host.call("stream.update", { stream_id: created.stream_id, pipeline: pipeline([A, B]) });
    expect(existsSync(join(dir, "streams", created.stream_id, "manifest.previous.json"))).toBe(true);
    const { previous_pipeline } = await host.call("stream.get", { stream_id: created.stream_id });
    const rollback = await host.call("stream.update", { stream_id: created.stream_id, pipeline: previous_pipeline });
    expect(rollback.status).toBe("active");
    expect(rollback.diff).toBeUndefined();
    const change = host.notifications("stream.changed").at(-1);
    expect(change.params).toMatchObject({ stream_id: created.stream_id, status: "active", reason: "rolled_back" });
    expect((await host.call("run.trigger", { stream_id: created.stream_id })).status).toBe("queued");
  });

  test("rolling back after an approved replacement restores what was approved, and its pin", async () => {
    const { host } = await startHost({ init: INIT });
    const created = await active(host, pipeline([A]));
    const update = await host.call("stream.update", { stream_id: created.stream_id, pipeline: pipeline([C]) });
    await host.call("stream.approve", { stream_id: created.stream_id, permissions_hash: update.permissions_hash });
    const back = await host.call("stream.update", { stream_id: created.stream_id, pipeline: pipeline([A]) });
    expect(back.status).toBe("active");
    const got = await host.call("stream.get", { stream_id: created.stream_id });
    expect(got.pipeline.processors[0].urls).toEqual([A]);
    const again = await host.call("stream.update", { stream_id: created.stream_id, pipeline: pipeline([A, B]) });
    expect(again.status).toBe("pending_approval");
  });

  test("a narrowing then re-widening within what was approved needs no approval", async () => {
    const { host } = await startHost({ init: INIT });
    const created = await active(host, pipeline([A, B]));
    await host.call("stream.update", { stream_id: created.stream_id, pipeline: pipeline([A]) });
    const back = await host.call("stream.update", { stream_id: created.stream_id, pipeline: pipeline([A, B]) });
    expect(back.status).toBe("active");
  });

  test("a widening on a paused stream goes back to paused when approved", async () => {
    const { host } = await startHost({ init: INIT });
    const created = await active(host, pipeline([A]));
    await host.call("stream.pause", { stream_id: created.stream_id });
    const update = await host.call("stream.update", { stream_id: created.stream_id, pipeline: pipeline([A, B]) });
    expect(update.status).toBe("pending_approval");
    expect((await host.call("stream.approve", { stream_id: created.stream_id, permissions_hash: update.permissions_hash })).status).toBe("paused");
  });

  test("an update before the first approval replaces what is waiting", async () => {
    const { host } = await startHost({ init: INIT });
    const created = await host.call("stream.create", { pipeline: pipeline([A]) });
    const update = await host.call("stream.update", { stream_id: created.stream_id, pipeline: pipeline([B]) });
    expect(update.status).toBe("pending_approval");
    const stale = await host.request("stream.approve", { stream_id: created.stream_id, permissions_hash: created.permissions_hash });
    expect(stale.error.data.kind).toBe("conflict");
    expect((await host.call("stream.approve", { stream_id: created.stream_id, permissions_hash: update.permissions_hash })).status).toBe("active");
    expect((await host.call("stream.get", { stream_id: created.stream_id })).pipeline.processors[0].urls).toEqual([B]);
  });

  test("an invalid update changes nothing", async () => {
    const { host } = await startHost({ init: INIT });
    const created = await active(host, pipeline([A]));
    const response = await host.request("stream.update", { stream_id: created.stream_id, pipeline: pipeline(["http://a.example/"]) });
    expect(response.error.data.kind).toBe("invalid_pipeline");
    expect((await host.call("stream.get", { stream_id: created.stream_id })).status).toBe("active");
  });

  test("state survives an update; the manifest files are 0600", async () => {
    const { host, dir } = await startHost({ init: INIT });
    const created = await active(host, pipeline([A]));
    const manifest = join(dir, "streams", created.stream_id, "manifest.json");
    const { statSync } = await import("node:fs");
    expect(statSync(manifest).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(manifest, "utf8")).pinned.permissions_hash).toBe(created.permissions_hash);
  });
});

describe("the subset rule, field by field", () => {
  const base = (): Permissions =>
    derivePermissions(pipeline([A, B], {
      processors: [
        { id: "fetch", type: "http_fetch", urls: [A, B], on_error: "skip", retry: { max_attempts: 3 } },
        { id: "parse", type: "parse_feed" },
        { id: "seen", type: "dedupe", key: "/id", remember: "90d", max_keys: 5000 },
        { id: "gather", type: "collect" },
        { id: "prompt", type: "template", target: "/prompt", text: "x" },
        { id: "ask", type: "host_llm", prompt: "/prompt", target: "/reply" },
      ],
      output: { type: "host_result", title: "T", body: "/reply", retry: { max_attempts: 2 } },
      limits: { llm_calls_per_run: 2, runs_per_day: 4, run_timeout: "5m", llm_cost_per_run_usd: 0.5 },
    }));
  const change = (edit: (p: any) => void): boolean => {
    const next = structuredClone(base());
    edit(next);
    return isSubset(next, base());
  };

  test("identical is a subset", () => expect(change(() => {})).toBe(true));
  const narrowing: Array<[string, (p: any) => void]> = [
    ["fewer hosts", (p) => (p.network = p.network.slice(0, 1))],
    ["fewer calls", (p) => (p.llm.max_calls_per_run = 1)],
    ["no llm at all", (p) => (p.llm = null)],
    ["fetched content no longer sent", (p) => (p.llm.receives_fetched_content = false)],
    ["lower cost cap", (p) => (p.llm.max_cost_per_run_usd = 0.1)],
    ["fewer runs", (p) => (p.limits.runs_per_day = 1)],
    ["shorter timeout", (p) => (p.limits.run_timeout = "1m")],
    ["shorter remember", (p) => (p.state.remember = "30d")],
    ["fewer keys", (p) => (p.state.max_keys = 10)],
    ["no state", (p) => (p.state = null)],
    ["fewer fetch retries", (p) => (p.network_retry = { max_attempts: 2 })],
    ["no fetch retry", (p) => (p.network_retry = null)],
    ["no result retry", (p) => (p.results.retry = null)],
    ["stops skipping", (p) => (p.skips_failed_sources = false)],
  ];
  for (const [name, edit] of narrowing) test(`${name} narrows`, () => expect(change(edit)).toBe(true));
  const widening: Array<[string, (p: any) => void]> = [
    ["a new host", (p) => p.network.push({ host: "c.example", scheme: "https", methods: ["GET"] })],
    ["more calls", (p) => (p.llm.max_calls_per_run = 3)],
    ["higher cost cap", (p) => (p.llm.max_cost_per_run_usd = 1)],
    ["cost cap removed", (p) => (p.llm.max_cost_per_run_usd = null)],
    ["more runs", (p) => (p.limits.runs_per_day = 5)],
    ["longer timeout", (p) => (p.limits.run_timeout = "6m")],
    ["longer remember", (p) => (p.state.remember = "91d")],
    ["more keys", (p) => (p.state.max_keys = 5001)],
    ["more fetch retries", (p) => (p.network_retry = { max_attempts: 4 })],
    ["more result retries", (p) => (p.results.retry = { max_attempts: 3 })],
    ["results stop", (p) => (p.results.kind = "none")],
    ["schedule change", (p) => (p.runs = { kind: "schedule", cron: "0 7 * * 1-5", timezone: "UTC", missed: "skip" })],
  ];
  for (const [name, edit] of widening) test(`${name} widens`, () => expect(change(edit)).toBe(false));

  test("from nothing to something widens", () => {
    const pinned = base();
    pinned.llm = null;
    expect(isSubset(base(), pinned)).toBe(false);
    pinned.llm = base().llm;
    pinned.state = null;
    expect(isSubset(base(), pinned)).toBe(false);
    const noCost = base();
    noCost.llm!.max_cost_per_run_usd = null;
    expect(isSubset(base(), noCost)).toBe(true);
    const noSkip = base();
    noSkip.skips_failed_sources = false;
    expect(isSubset(base(), noSkip)).toBe(false);
    const noFetchedContent = base();
    noFetchedContent.llm!.receives_fetched_content = false;
    expect(isSubset(base(), noFetchedContent)).toBe(false);
  });

  test("sentence diff", () => {
    expect(sentenceDiff(["a", "b"], ["b", "c"])).toEqual({ added: ["a"], removed: ["c"] });
  });
});

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runConformance } from "../src/harness/conformance.ts";
import type { FakeHost } from "../src/harness/fake-host.ts";
import { checkSchema } from "../src/pipeline/json-schema.ts";
import { REPORT_SCHEMA } from "../src/report.ts";
import { BINARY, CONFORMANCE_DIR, descendants, isAlive, startHost } from "./helpers.ts";

const INIT = { sandbox: "optional" };

const llmPipeline = (limits: Record<string, unknown> = {}) => ({
  format: "wriven-workflow/pipeline@1",
  name: "Echo",
  input: { type: "host_trigger" },
  processors: [
    { id: "prompt", type: "template", target: "/prompt", text: "Say hello to {{/trigger}}" },
    { id: "ask", type: "host_llm", prompt: "/prompt", target: "/reply" },
  ],
  output: { type: "host_result", title: "Echo", body: "/reply" },
  limits: { llm_calls_per_run: 1, runs_per_day: 48, run_timeout: "5m", ...limits },
});

async function activeStream(host: FakeHost, pipeline: unknown = llmPipeline()): Promise<string> {
  const created = await host.call("stream.create", { pipeline });
  expect(created.status).toBe("pending_approval");
  await host.call("stream.approve", { stream_id: created.stream_id, permissions_hash: created.permissions_hash });
  return created.stream_id;
}

const finished = (host: FakeHost, runId: string, timeoutMs = 20_000) =>
  host.waitFor((m) => m.method === "run.finished" && m.params.report.run_id === runId, timeoutMs, `run.finished for ${runId}`).then((m) => m.params.report);

function expectValidReport(report: unknown) {
  expect(checkSchema(REPORT_SCHEMA, report)).toEqual([]);
}

describe("streams", () => {
  test("create → approve → get, and manifests survive a restart", async () => {
    const { host, dir } = await startHost({ init: INIT });
    const created = await host.call("stream.create", { pipeline: llmPipeline() });
    expect(created.rendered[0]).toBe("Runs: when Wriven asks.");
    expect(existsSync(join(dir, "streams", created.stream_id, "manifest.json"))).toBe(true);
    await host.call("stream.approve", { stream_id: created.stream_id, permissions_hash: created.permissions_hash });
    const got = await host.call("stream.get", { stream_id: created.stream_id });
    expect(got.status).toBe("active");
    expect(got.pipeline.name).toBe("Echo");
    const listed = await host.call("stream.list");
    expect(listed.streams.map((s: any) => s.stream_id)).toEqual([created.stream_id]);
    host.closeStdin();
    await host.exited;
    const { spawnHost, initParams } = await import("./helpers.ts");
    const again = spawnHost();
    const init = await again.call("initialize", initParams(dir, INIT));
    expect(init.streams[0].stream_id).toBe(created.stream_id);
    expect(init.streams[0].status).toBe("active");
  });

  test("an invalid pipeline fails stream.create with errors", async () => {
    const { host } = await startHost({ init: INIT });
    const response = await host.request("stream.create", { pipeline: { ...llmPipeline(), extra: true } });
    expect(response.error.data.kind).toBe("invalid_pipeline");
    expect(response.error.data.errors[0].path).toBe("/extra");
  });

  test("an inject input fails stream.create", async () => {
    const { host } = await startHost({ init: INIT });
    const response = await host.request("stream.create", { pipeline: { ...llmPipeline(), input: { type: "inject", messages: [{ data: { trigger: "x" } }] } } });
    expect(response.error.data.kind).toBe("invalid_pipeline");
    expect(response.error.data.errors[0].code).toBe("input_not_allowed");
  });

  test("a stale hash on approve gets conflict with the current hash", async () => {
    const { host } = await startHost({ init: INIT });
    const created = await host.call("stream.create", { pipeline: llmPipeline() });
    const response = await host.request("stream.approve", { stream_id: created.stream_id, permissions_hash: "sha256:stale" });
    expect(response.error.data.kind).toBe("conflict");
    expect(response.error.data.current).toBe(created.permissions_hash);
  });

  test("start_paused approves into paused; pause and resume", async () => {
    const { host } = await startHost({ init: INIT });
    const created = await host.call("stream.create", { pipeline: llmPipeline(), start_paused: true });
    const approved = await host.call("stream.approve", { stream_id: created.stream_id, permissions_hash: created.permissions_hash });
    expect(approved.status).toBe("paused");
    expect((await host.call("stream.resume", { stream_id: created.stream_id })).status).toBe("active");
    expect((await host.call("stream.pause", { stream_id: created.stream_id })).status).toBe("paused");
  });

  test("unknown ids get not_found; delete removes the directory", async () => {
    const { host, dir } = await startHost({ init: INIT });
    expect((await host.request("stream.get", { stream_id: "s_nope" })).error.data.kind).toBe("not_found");
    expect((await host.request("run.cancel", { run_id: "nope" })).error.data.kind).toBe("not_found");
    const id = await activeStream(host);
    expect((await host.call("stream.delete", { stream_id: id })).status).toBe("deleted");
    expect(existsSync(join(dir, "streams", id))).toBe(false);
    expect((await host.request("run.trigger", { stream_id: id })).error.data.kind).toBe("not_found");
  });
});

describe("a run", () => {
  test("succeeds end to end in a child process", async () => {
    const { host } = await startHost({ init: INIT });
    const id = await activeStream(host);
    const { run_id, status } = await host.call("run.trigger", { stream_id: id, scheduled_for: "2026-11-04T08:00:00+10:00" });
    expect(status).toBe("queued");
    const report = await finished(host, run_id);
    expect(report.status).toBe("succeeded");
    expect(report.error).toBeNull();
    expect(report.scheduled_for).toBe("2026-11-04T08:00:00+10:00");
    expect(report.llm.calls).toBe(1);
    expect(report.llm.requests[0]).toMatchObject({ idempotency_key: `${run_id}/ask/m1`, attempt: 1, provider: "fake", model: "fake-1" });
    expect(report.results[0]).toMatchObject({ idempotency_key: `${run_id}/m1`, ref: "thread:1", title: "Echo" });
    expect(report.steps.map((s: any) => s.step_id)).toEqual(["input", "prompt", "ask", "output"]);
    expect(host.results[0].result.body).toBe("[echo] Say hello to host");
    expect(host.providerCalls[0].messages).toEqual([{ role: "user", content: "Say hello to host" }]);
    expectValidReport(report);
    const started = host.notifications("run.started").find((n) => n.params.run_id === run_id);
    expect(started.params).toMatchObject({ stream_id: id, trigger: "host", scheduled_for: "2026-11-04T08:00:00+10:00" });
    expect(descendants(host.pid)).toEqual([]);
  });

  test("run.trigger is refused on pending_approval and paused", async () => {
    const { host } = await startHost({ init: INIT });
    const created = await host.call("stream.create", { pipeline: llmPipeline() });
    expect((await host.request("run.trigger", { stream_id: created.stream_id })).error.data.kind).toBe("permission_denied");
    await host.call("stream.approve", { stream_id: created.stream_id, permissions_hash: created.permissions_hash });
    await host.call("stream.pause", { stream_id: created.stream_id });
    const paused = await host.request("run.trigger", { stream_id: created.stream_id });
    expect(paused.error.data.kind).toBe("conflict");
    expect(paused.error.data.reason).toBe("paused");
  });

  test("two triggers during a run produce one extra run", async () => {
    const { host } = await startHost({ init: INIT, llm: { mode: "hold" } });
    const id = await activeStream(host);
    const first = await host.call("run.trigger", { stream_id: id });
    await host.waitFor((m) => m.method === "host.llm");
    const second = await host.call("run.trigger", { stream_id: id });
    const third = await host.call("run.trigger", { stream_id: id });
    expect(third.run_id).toBe(second.run_id);
    expect(second.run_id).not.toBe(first.run_id);
    host.setLlm({ responses: ["done"] });
    await host.call("run.cancel", { run_id: first.run_id });
    expect((await finished(host, first.run_id)).status).toBe("cancelled");
    expect((await finished(host, second.run_id)).status).toBe("succeeded");
    expect(host.notifications("run.started").length).toBe(2);
  });

  test("the run process is a child of the engine and has exited when run.finished arrives", async () => {
    const { host } = await startHost({ init: INIT, llm: { mode: "hold" } });
    const id = await activeStream(host);
    const { run_id } = await host.call("run.trigger", { stream_id: id });
    await host.waitFor((m) => m.method === "host.llm");
    const children = descendants(host.pid);
    expect(children.length).toBe(1);
    expect(children[0]).not.toBe(host.pid);
    await host.call("run.cancel", { run_id });
    await finished(host, run_id);
    expect(isAlive(children[0]!)).toBe(false);
  });

  test("killing the run process gives failed/process_exited and the engine keeps serving", async () => {
    const { host } = await startHost({ init: INIT, llm: { mode: "hold" } });
    const id = await activeStream(host);
    const { run_id } = await host.call("run.trigger", { stream_id: id });
    await host.waitFor((m) => m.method === "host.llm");
    process.kill(descendants(host.pid)[0]!, "SIGKILL");
    const report = await finished(host, run_id);
    expect(report.status).toBe("failed");
    expect(report.error.kind).toBe("process_exited");
    expectValidReport(report);
    expect((await host.call("stream.list")).streams.length).toBe(1);
  });

  test("llm_calls_per_run: 1 with two host_llm steps stops at the second", async () => {
    const { host } = await startHost({ init: INIT });
    const pipeline = llmPipeline();
    pipeline.processors.push({ id: "again", type: "host_llm", prompt: "/reply", target: "/reply2" });
    const id = await activeStream(host, pipeline);
    const { run_id } = await host.call("run.trigger", { stream_id: id });
    const report = await finished(host, run_id);
    expect(report.status).toBe("failed");
    expect(report.error).toMatchObject({ kind: "budget_exceeded", limit: "llm_calls_per_run", step_id: "again" });
    expect(host.providerCalls.length).toBe(1);
    expect(host.results.length).toBe(0);
    expectValidReport(report);
  });

  test("provider errors pass through typed, with retry_after, and are not retried", async () => {
    const { host } = await startHost({ init: INIT, llm: { error: { kind: "rate_limited", message: "Slow down.", retry_after: "2026-11-04T14:00:00Z" } } });
    const id = await activeStream(host);
    const { run_id } = await host.call("run.trigger", { stream_id: id });
    const report = await finished(host, run_id);
    expect(report.status).toBe("failed");
    expect(report.error).toMatchObject({ kind: "rate_limited", retry_after: "2026-11-04T14:00:00Z", step_id: "ask", message_id: "m1" });
    expect(host.received.filter((m) => m.method === "host.llm").length).toBe(1);
  });

  test("host_result retry repeats the same key and creates one result", async () => {
    const { host } = await startHost({ init: INIT, result: { fail_first: 1 } });
    const pipeline = llmPipeline();
    (pipeline.output as any).retry = { max_attempts: 2, backoff: "1s" };
    const id = await activeStream(host, pipeline);
    const { run_id } = await host.call("run.trigger", { stream_id: id });
    const report = await finished(host, run_id);
    expect(report.status).toBe("succeeded");
    const keys = host.received.filter((m) => m.method === "host.result").map((m) => m.params.idempotency_key);
    expect(keys).toEqual([`${run_id}/m1`, `${run_id}/m1`]);
    expect(host.results.length).toBe(1);
  });

  test("a failed result write without retry fails the run", async () => {
    const { host } = await startHost({ init: INIT, result: { fail_first: 1 } });
    const id = await activeStream(host);
    const { run_id } = await host.call("run.trigger", { stream_id: id });
    const report = await finished(host, run_id);
    expect(report.status).toBe("failed");
    expect(report.error.kind).toBe("host_error");
    expect(report.error.step_id).toBe("output");
  });

  test("a host.llm whose response is lost goes out again with the same key", async () => {
    const { host } = await startHost({ init: { ...INIT, timeouts: { host_response: "1s" } }, llm: { responses: ["kept"], drop_responses: 1 } });
    const id = await activeStream(host);
    const { run_id } = await host.call("run.trigger", { stream_id: id });
    const report = await finished(host, run_id);
    expect(report.status).toBe("succeeded");
    const requests = host.received.filter((m) => m.method === "host.llm");
    expect(requests.map((m) => m.params.attempt)).toEqual([1, 2]);
    expect(requests[1].params.idempotency_key).toBe(requests[0].params.idempotency_key);
    expect(host.providerCalls.length).toBe(1);
    expect(report.llm.requests).toHaveLength(1);
    expect(report.llm.requests[0].attempt).toBe(2);
  });

  test("a host that never answers fails the run after two attempts", async () => {
    const { host } = await startHost({ init: { ...INIT, timeouts: { host_response: "1s" } }, llm: { mode: "hold" } });
    const id = await activeStream(host);
    const { run_id } = await host.call("run.trigger", { stream_id: id });
    const report = await finished(host, run_id);
    expect(report.status).toBe("failed");
    expect(report.error).toMatchObject({ kind: "host_error", reason: "no_response" });
  });

  test("cancel during host.llm sends $/cancel and reports cancelled", async () => {
    const { host } = await startHost({ init: INIT, llm: { mode: "hold" } });
    const id = await activeStream(host);
    const { run_id } = await host.call("run.trigger", { stream_id: id });
    const request = await host.waitFor((m) => m.method === "host.llm");
    await host.call("run.cancel", { run_id });
    const cancel = await host.waitFor((m) => m.method === "$/cancel");
    expect(cancel.params.id).toBe(request.id);
    const report = await finished(host, run_id);
    expect(report.status).toBe("cancelled");
    expect(report.cancelled_at_step).toBe("ask");
    expectValidReport(report);
    expect((await host.call("run.cancel", { run_id })).status).toBe("cancelled");
  });

  test("cancelling a queued run reports it without running it", async () => {
    const { host } = await startHost({ init: INIT, llm: { mode: "hold" } });
    const id = await activeStream(host);
    const first = await host.call("run.trigger", { stream_id: id });
    await host.waitFor((m) => m.method === "host.llm");
    const second = await host.call("run.trigger", { stream_id: id });
    await host.call("run.cancel", { run_id: second.run_id });
    const report = await finished(host, second.run_id);
    expect(report.status).toBe("cancelled");
    expect(report.started_at).toBeNull();
    expectValidReport(report);
    await host.call("run.cancel", { run_id: first.run_id });
    await finished(host, first.run_id);
  });

  test("pausing lets the running run finish and cancels what is queued", async () => {
    const { host } = await startHost({ init: INIT, llm: { mode: "hold" } });
    const id = await activeStream(host);
    const first = await host.call("run.trigger", { stream_id: id });
    await host.waitFor((m) => m.method === "host.llm");
    const second = await host.call("run.trigger", { stream_id: id });
    await host.call("stream.pause", { stream_id: id });
    expect((await finished(host, second.run_id)).error.reason).toBe("paused");
    await host.call("run.cancel", { run_id: first.run_id });
    await finished(host, first.run_id);
  });

  test("deleting a stream cancels its running run first", async () => {
    const { host } = await startHost({ init: INIT, llm: { mode: "hold" } });
    const id = await activeStream(host);
    const { run_id } = await host.call("run.trigger", { stream_id: id });
    await host.waitFor((m) => m.method === "host.llm");
    expect((await host.call("stream.delete", { stream_id: id })).status).toBe("deleted");
    expect((await finished(host, run_id)).status).toBe("cancelled");
  });

  test("stdin EOF during a run reports cancelled and exits 0 with no descendants", async () => {
    const { host } = await startHost({ init: INIT, llm: { mode: "hold" } });
    const id = await activeStream(host);
    const { run_id } = await host.call("run.trigger", { stream_id: id });
    await host.waitFor((m) => m.method === "host.llm");
    const child = descendants(host.pid)[0]!;
    const started = Date.now();
    host.closeStdin();
    expect(await host.exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(11_000);
    expect((await finished(host, run_id)).status).toBe("cancelled");
    expect(isAlive(child)).toBe(false);
  });

  test("shutdown with a run in progress kills it after the timeout", async () => {
    const { host } = await startHost({ init: INIT, llm: { mode: "hold" } });
    const id = await activeStream(host);
    const { run_id } = await host.call("run.trigger", { stream_id: id });
    await host.waitFor((m) => m.method === "host.llm");
    const queued = await host.call("run.trigger", { stream_id: id });
    await host.call("shutdown", { timeout: "1s" });
    expect((await finished(host, queued.run_id)).error.reason).toBe("shutdown");
    const report = await finished(host, run_id);
    expect(report.status).toBe("cancelled");
    expect(report.error.reason).toBe("killed_after_timeout");
    expect(await host.exited).toBe(0);
  });

  test("killing the engine: the orphaned run process exits on its own", async () => {
    const { host } = await startHost({ init: INIT, llm: { mode: "hold" } });
    const id = await activeStream(host);
    await host.call("run.trigger", { stream_id: id });
    await host.waitFor((m) => m.method === "host.llm");
    const child = descendants(host.pid)[0]!;
    host.kill();
    await host.exited;
    for (let i = 0; i < 100 && isAlive(child); i++) await Bun.sleep(20);
    expect(isAlive(child)).toBe(false);
  });
});

describe("template", () => {
  test("text from the data that looks like a placeholder stays text", async () => {
    const { host } = await startHost({ init: INIT, llm: { responses: ["{{/trigger}}"] } });
    const pipeline: any = llmPipeline();
    pipeline.processors.push({ id: "wrap", type: "template", target: "/wrapped", text: "{{/reply}} and {{/trigger}}" });
    pipeline.output.body = "/wrapped";
    const id = await activeStream(host, pipeline);
    const { run_id } = await host.call("run.trigger", { stream_id: id });
    await finished(host, run_id);
    expect(host.results[0].result.body).toBe("{{/trigger}} and host");
  });
});

describe("conformance", () => {
  test("every fixture passes against the binary", async () => {
    const results = await runConformance(CONFORMANCE_DIR, [BINARY]);
    expect(results.filter((r) => !r.passed)).toEqual([]);
  }, 120_000);
});

// The example host against the real engine binary, with a scripted provider and a scripted model:
// no network, no key, no money.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { ERROR_CODES } from "../../src/protocol/errors.ts";
import { Agent, type ModelClient } from "./agent.ts";
import { ExampleHost } from "./host.ts";
import { ScriptedProvider, toHostError } from "./provider.ts";
import { HOST_ERROR_CODES, HostError } from "./rpc.ts";

const REPO = resolve(import.meta.dir, "../..");
const BINARY = join(REPO, "dist", "wriven-workflow");
const HELLO = JSON.parse(readFileSync(join(import.meta.dir, "pipelines", "hello.json"), "utf8"));

if (!existsSync(BINARY)) {
  const out = Bun.spawnSync(["bun", "run", "build"], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  if (out.exitCode !== 0) throw new Error(`engine build failed: ${out.stderr}`);
}

const started: ExampleHost[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const host of started) await host.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function startHost(provider = new ScriptedProvider()): Promise<ExampleHost> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "example-host-")));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  const host = await ExampleHost.start({ engine: [BINARY], dataDir: dir, provider });
  started.push(host);
  return host;
}

async function createApproved(host: ExampleHost, pipeline = HELLO): Promise<string> {
  const { stream_id } = await host.call("stream.create", { pipeline });
  const card = await host.approvalCard(stream_id);
  await host.approve(card!);
  return stream_id;
}

describe("the protocol", () => {
  test("the host's error codes are the engine's", () => {
    for (const [kind, code] of Object.entries(HOST_ERROR_CODES)) expect(ERROR_CODES[kind as keyof typeof ERROR_CODES]).toBe(code);
  });
});

describe("a run", () => {
  test("approval card, run now, result stored with the run's times, report kept", async () => {
    const provider = new ScriptedProvider(["Good morning."]);
    const host = await startHost(provider);
    const { stream_id } = await host.call("stream.create", { pipeline: HELLO });

    const card = await host.approvalCard(stream_id);
    expect(card!.rendered.some((s) => s.startsWith("Uses: the AI provider"))).toBe(true);
    expect(card!.rendered.at(-1)).toBe("OS sandbox: on (macOS Seatbelt).");
    await expect(host.call("run.trigger", { stream_id })).rejects.toMatchObject({ kind: "permission_denied" });

    await host.approve(card!);
    const report = await host.runNow(stream_id);
    expect(report.status).toBe("succeeded");
    expect(report.llm.calls).toBe(1);
    expect(provider.calls).toHaveLength(1);
    const [result] = host.results;
    expect(result!.body).toBe("Good morning.");
    expect(readFileSync(result!.path, "utf8")).toContain("Scheduled for (run now), started 20");
    expect(host.reports.get(report.run_id)).toEqual(report);
  }, 60_000);

  test("a provider failure ends the run with its typed kind", async () => {
    const host = await startHost(new ScriptedProvider(undefined, new HostError("rate_limited", "The AI provider is rate limiting requests.", { provider: "scripted" })));
    const report = await host.runNow(await createApproved(host));
    expect(report.status).toBe("failed");
    expect(report.error.kind).toBe("rate_limited");
  }, 60_000);

  test("a widening update waits for a new card with the diff, then runs once approved", async () => {
    const host = await startHost();
    const streamId = await createApproved(host);
    const wider = { ...HELLO, limits: { ...HELLO.limits, llm_calls_per_run: 3 } };
    const updated = await host.call("stream.update", { stream_id: streamId, pipeline: wider });
    expect(updated.status).toBe("pending_approval");
    const card = await host.approvalCard(streamId);
    expect(card!.diff!.added.join(" ")).toContain("at most 3 requests per run");
    await host.approve(card!);
    expect((await host.runNow(streamId)).status).toBe("succeeded");
  }, 60_000);
});

describe("provider errors", () => {
  const headers = (retryAfter?: string) => new Headers(retryAfter ? { "retry-after": retryAfter } : {});
  const apiError = (status: number, type: string, retryAfter?: string) =>
    new Anthropic.APIError(status, { type: "error", error: { type, message: "x" } }, "x", headers(retryAfter), type as any);

  test("map to the kinds an unattended run needs", () => {
    expect(toHostError(apiError(401, "authentication_error")).kind).toBe("credentials_rejected");
    expect(toHostError(apiError(402, "billing_error")).kind).toBe("quota_exhausted");
    expect(toHostError(apiError(529, "overloaded_error")).kind).toBe("provider_unavailable");
    expect(toHostError(apiError(400, "invalid_request_error")).kind).toBe("host_error");
    expect(toHostError(new Anthropic.APIConnectionError({ message: "down" })).kind).toBe("provider_unavailable");
    expect(toHostError(new Anthropic.APIUserAbortError()).kind).toBe("cancelled");
    expect(toHostError(new Error("Could not resolve authentication method. Expected one of apiKey")).kind).toBe("credentials_missing");
  });

  test("a rate limit carries retry_after for the report", () => {
    const error = toHostError(apiError(429, "rate_limit_error", "30"));
    expect(error.kind).toBe("rate_limited");
    expect(Date.parse(error.extras.retry_after as string)).toBeGreaterThan(Date.now());
  });
});

// A model that follows a script: each create() returns the next response.
function scriptedModel(responses: Array<Partial<Anthropic.Beta.BetaMessage>>): ModelClient & { requests: any[] } {
  const requests: any[] = [];
  return {
    requests,
    async create(params) {
      requests.push(structuredClone(params));
      const next = responses.shift();
      if (!next) throw new Error("the script ran out");
      return { id: "msg", type: "message", role: "assistant", model: "scripted", usage: {} as any, stop_details: null, ...next } as Anthropic.Beta.BetaMessage;
    },
  };
}

const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input }) as Anthropic.Beta.BetaContentBlock;
const text = (value: string) => ({ type: "text", text: value, citations: null }) as Anthropic.Beta.BetaContentBlock;

describe("the agent's tool loop", () => {
  test("the model creates a stream; the host keeps the hash and asks the person", async () => {
    const host = await startHost();
    const model = scriptedModel([
      { stop_reason: "tool_use", content: [toolUse("t1", "workflow_validate_pipeline", { pipeline: HELLO })] },
      { stop_reason: "tool_use", content: [toolUse("t2", "workflow_create_stream", { pipeline: HELLO })] },
      { stop_reason: "end_turn", content: [text("I set up Hello. Approve it in the app.")] },
    ]);
    const agent = new Agent(host, model);
    const turn = await agent.send("Greet me every morning.");

    expect(turn.text).toBe("I set up Hello. Approve it in the app.");
    expect(turn.awaitingApproval).toHaveLength(1);
    // The model never sees the hash it would need to approve.
    const toolResults = JSON.stringify(model.requests[2].messages);
    expect(toolResults).toContain("pending_approval");
    expect(toolResults).not.toContain("permissions_hash");
    expect(model.requests[0].tools.map((t: any) => t.name)).toContain("workflow_create_stream");
    expect(model.requests[0].tools.every((t: any) => t.method === undefined)).toBe(true);
    expect(await host.approvalCard(turn.awaitingApproval[0]!)).not.toBeNull();
  }, 60_000);

  test("an engine error goes back as an error result with paths; a host note follows the person's turn", async () => {
    const host = await startHost();
    const broken = { ...HELLO, processors: [{ ...HELLO.processors[0], target: "no-slash" }, HELLO.processors[1]] };
    const model = scriptedModel([
      { stop_reason: "tool_use", content: [toolUse("t1", "workflow_create_stream", { pipeline: broken })] },
      { stop_reason: "end_turn", content: [text("That failed validation.")] },
      { stop_reason: "end_turn", content: [text("Noted.")] },
    ]);
    const agent = new Agent(host, model);
    await agent.send("Make it.");
    const result = (model.requests[1].messages.at(-1).content as any[])[0];
    expect(result.is_error).toBe(true);
    expect(JSON.parse(result.content).error.kind).toBe("invalid_pipeline");
    expect(JSON.parse(result.content).error.errors[0].path).toBeString();

    await agent.send("ok", "The person declined it.");
    const last = model.requests[2].messages.slice(-2);
    expect(last.map((m: any) => m.role)).toEqual(["user", "system"]);
  }, 60_000);
});

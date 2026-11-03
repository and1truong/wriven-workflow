import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeHost } from "../src/harness/fake-host.ts";
import { generateProfile, sbplString } from "../src/supervisor/seatbelt.ts";
import { BINARY, REPO, startHost, startInProcess } from "./helpers.ts";

const pipeline = {
  format: "wriven-workflow/pipeline@1",
  name: "Echo",
  input: { type: "host_trigger" },
  processors: [
    { id: "prompt", type: "template", target: "/prompt", text: "Say hello to {{/trigger}}" },
    { id: "ask", type: "host_llm", prompt: "/prompt", target: "/reply" },
  ],
  output: { type: "host_result", title: "Echo", body: "/reply" },
  limits: { llm_calls_per_run: 1, runs_per_day: 48, run_timeout: "5m" },
};

async function run(host: FakeHost): Promise<any> {
  const created = await host.call("stream.create", { pipeline });
  await host.call("stream.approve", { stream_id: created.stream_id, permissions_hash: created.permissions_hash });
  const { run_id } = await host.call("run.trigger", { stream_id: created.stream_id });
  const finished = await host.waitFor((m) => m.method === "run.finished" && m.params.report.run_id === run_id, 20_000);
  return finished.params.report;
}

describe("doctor", () => {
  test("--self-test: everything forbidden is denied and everything allowed works", () => {
    const out = Bun.spawnSync([BINARY, "doctor", "--self-test"], { stdout: "pipe", stderr: "pipe" });
    const report = JSON.parse(out.stdout.toString());
    expect(report.checks.filter((c: any) => !c.ok)).toEqual([]);
    expect(report.sandbox).toBe("seatbelt ok");
    expect(report.proxy_can_bind).toBe(true);
    expect(report.signing).toBeString();
    expect(out.exitCode).toBe(0);
    const names = report.checks.map((c: any) => c.name);
    expect(names).toContain("read ~/.ssh/id_rsa");
    expect(names).toContain("write ~/Desktop/x");
    expect(names).toContain("read the stream's manifest");
    expect(names).toContain("write the stream's manifest");
    expect(names).toContain("read another process's arguments and environment");
    expect(names).toContain("hard-link an outside file into the temp directory");
    expect(names).toContain("read an outside file through a symlink");
    expect(names).toContain("signal another process");
    expect(names).toContain("exec /bin/sh");
    expect(names).toContain("bind a port");
    expect(names).toContain("connect to 1.1.1.1:443");
    expect(names).toContain("connect to the allowed localhost port");
  }, 30_000);

  test("exits non-zero when sandbox-exec cannot be found", () => {
    const out = Bun.spawnSync([BINARY, "doctor"], { env: { PATH: "/nonexistent" }, stdout: "pipe", stderr: "pipe" });
    expect(out.exitCode).toBe(1);
    expect(JSON.parse(out.stdout.toString()).sandbox).toStartWith("not working");
  });
});

describe("a run under the sandbox", () => {
  test("works end to end and the report says seatbelt", async () => {
    const { host, init } = await startHost();
    expect(init.sandbox).toEqual({ available: true, mechanism: "seatbelt" });
    const report = await run(host);
    expect(report.status).toBe("succeeded");
    expect(report.sandbox).toBe("seatbelt");
    expect(host.results.length).toBe(1);
  });

  test("required without sandbox-exec: trigger refused, sentence changed", async () => {
    const { host } = await startHost({ env: { PATH: "/nonexistent" } });
    const created = await host.call("stream.create", { pipeline });
    expect(created.rendered.at(-1)).toBe("OS sandbox: unavailable on this Mac; only the engine's own checks apply.");
    await host.call("stream.approve", { stream_id: created.stream_id, permissions_hash: created.permissions_hash });
    const response = await host.request("run.trigger", { stream_id: created.stream_id });
    expect(response.error.data.kind).toBe("sandbox_unavailable");
    expect(response.error.data.reason).toContain("sandbox-exec");
  });

  test("optional without sandbox-exec: runs and says none", async () => {
    const { host, init } = await startHost({ env: { PATH: "/nonexistent" }, init: { sandbox: "optional" } });
    expect(init.sandbox.available).toBe(false);
    const report = await run(host);
    expect(report.status).toBe("succeeded");
    expect(report.sandbox).toBe("none");
  });

  test("past the memory ceiling: failed/memory_limit, and the engine survives", async () => {
    const { host } = await startInProcess({
      init: { ceilings: { run_memory_mb: 150 } },
      engine: { test: { hook: { allocate_mb: 400 }, memorySampleMs: 20 } },
      llm: { mode: "hold" },
    });
    const report = await run(host);
    expect(report.status).toBe("failed");
    expect(report.error.kind).toBe("memory_limit");
    expect((await host.call("stream.list")).streams.length).toBe(1);
  }, 30_000);

  test("past run_timeout: timed_out, with the outstanding request cancelled", async () => {
    const { host } = await startInProcess({ engine: { test: { runTimeoutMs: 500 } }, llm: { mode: "hold" } });
    const report = await run(host);
    expect(report.status).toBe("timed_out");
    expect(report.error.kind).toBe("timed_out");
    expect(report.error.step_id).toBe("ask");
    expect(host.received.some((m) => m.method === "$/cancel")).toBe(true);
    expect((await host.call("stream.list")).streams.length).toBe(1);
  }, 30_000);
});

describe("the profile", () => {
  const input = { programPaths: ["/opt/bin/w"], tempDir: "/s/tmp", stateFiles: ["/s/state.json"], proxyPort: null };

  test("is deny by default, names no directory of the stream, and has no network without a proxy", () => {
    const profile = generateProfile(input);
    expect(profile).toStartWith("(version 1)\n(deny default)\n");
    expect(profile).toContain('(literal "/s/state.json")');
    expect(profile).not.toContain('(subpath "/s")');
    expect(profile).not.toContain("network-outbound");
    expect(profile).not.toContain("mach-lookup");
    expect(generateProfile({ ...input, proxyPort: 4242 })).toContain('(allow network-outbound (remote tcp "localhost:4242"))');
  });

  test("escapes paths", () => {
    expect(sbplString('/a "b"\\c')).toBe('"/a \\"b\\"\\\\c"');
    expect(() => sbplString("/a\nb")).toThrow();
  });
});

describe("validation touches nothing", () => {
  test("validates under a profile with no network and no writes outside its temp directory", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "wriven-workflow-validate-")));
    try {
      const profile = generateProfile({ programPaths: [realpathSync(BINARY)], tempDir: dir, stateFiles: [], proxyPort: null });
      const document = readFileSync(join(REPO, "fixtures/pipelines/valid/trigger-template-result.json"));
      const out = Bun.spawnSync(["sandbox-exec", "-p", profile, realpathSync(BINARY), "validate", "-"], { stdin: document, cwd: dir, env: { HOME: dir, TMPDIR: dir }, stdout: "pipe", stderr: "pipe" });
      expect(out.exitCode).toBe(0);
      expect(JSON.parse(out.stdout.toString()).valid).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

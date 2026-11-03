import { describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { runConformance } from "../src/harness/conformance.ts";
import { BINARY, CONFORMANCE_DIR, descendants, initParams, isAlive, spawnHost, startHost, stateDir } from "./helpers.ts";

describe("handshake", () => {
  test("a request before initialize gets not_initialized", async () => {
    const host = spawnHost();
    const response = await host.request("components.list");
    expect(response.error.data.kind).toBe("not_initialized");
    expect(response.error.code).toBe(-32001);
  });

  test("protocol_version 2 gets unsupported_version listing what is supported", async () => {
    const host = spawnHost();
    const response = await host.request("initialize", initParams(stateDir(), { protocol_version: 2 }));
    expect(response.error.data.kind).toBe("unsupported_version");
    expect(response.error.data.supported).toEqual([1]);
  });

  test("a state_dir with mode 0755 gets invalid_state_dir", async () => {
    const dir = stateDir();
    chmodSync(dir, 0o755);
    const host = spawnHost();
    const response = await host.request("initialize", initParams(dir));
    expect(response.error.data.kind).toBe("invalid_state_dir");
    expect(response.error.data.reason).toBe("wrong_mode");
  });

  test("a missing state_dir gets invalid_state_dir", async () => {
    const host = spawnHost();
    const response = await host.request("initialize", initParams("/nonexistent/wriven-workflow"));
    expect(response.error.data.kind).toBe("invalid_state_dir");
    expect(response.error.data.reason).toBe("missing");
  });

  test("a second engine on the same state_dir gets conflict; the first one's exit frees it", async () => {
    const { host: first, dir } = await startHost();
    const second = spawnHost();
    const response = await second.request("initialize", initParams(dir));
    expect(response.error.data.kind).toBe("conflict");
    first.closeStdin();
    await first.exited;
    const retry = await second.request("initialize", initParams(dir));
    expect(retry.result.protocol_version).toBe(1);
  });

  test("a second initialize on one connection gets conflict", async () => {
    const { host, dir } = await startHost();
    const response = await host.request("initialize", initParams(dir));
    expect(response.error.data.kind).toBe("conflict");
    expect(response.error.data.reason).toBe("already_initialized");
  });
});

describe("framing", () => {
  test("a 4 MiB + 1 byte line gets -32600 and the engine keeps serving", async () => {
    const { host } = await startHost();
    host.sendRaw("x".repeat(4 * 1024 * 1024 + 1));
    const error = await host.waitFor((m) => m.error?.code === -32600);
    expect(error.id).toBeNull();
    expect((await host.call("components.list")).components).toBeDefined();
  }, 30_000);

  test("a line of exactly 4 MiB is accepted", async () => {
    const { host } = await startHost();
    const prefix = '{"jsonrpc":"2.0","method":"x","params":"';
    const suffix = '"}';
    host.sendRaw(prefix + "y".repeat(4 * 1024 * 1024 - prefix.length - suffix.length) + suffix);
    expect((await host.call("components.list")).components).toBeDefined();
    expect(host.received.some((m) => m.error?.code === -32600)).toBe(false);
  }, 30_000);

  test("unparseable JSON gets -32700 and the engine keeps serving", async () => {
    const { host } = await startHost();
    host.sendRaw("{not json");
    await host.waitFor((m) => m.error?.code === -32700);
    expect((await host.call("components.list")).components).toBeDefined();
  });

  test("an unknown method has a kind from the table", async () => {
    const { host } = await startHost();
    const response = await host.request("no.such.method");
    expect(response.error.code).toBe(-32601);
    expect(response.error.data.kind).toBe("method_not_found");
  });

  test("stdout carries protocol messages only; stderr carries JSON logs", async () => {
    const { host } = await startHost();
    host.closeStdin();
    await host.exited;
    for (const message of host.received) expect(message.jsonrpc).toBe("2.0");
    for (const line of host.stderr) expect(typeof JSON.parse(line).msg).toBe("string");
  });
});

describe("exit", () => {
  test("stdin EOF exits 0 within the timeout with no descendants", async () => {
    const { host } = await startHost();
    const started = Date.now();
    host.closeStdin();
    expect(await host.exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(11_000);
    expect(isAlive(host.pid)).toBe(false);
    expect(descendants(host.pid)).toEqual([]);
  });

  test("stdin EOF before initialize exits 0", async () => {
    const host = spawnHost();
    host.closeStdin();
    expect(await host.exited).toBe(0);
  });

  test("shutdown answers, then exits 0", async () => {
    const { host } = await startHost();
    expect(await host.call("shutdown")).toEqual({});
    expect(await host.exited).toBe(0);
  });
});

describe("cli", () => {
  test("--version prints the versions as JSON", () => {
    const out = Bun.spawnSync([BINARY, "--version"]);
    expect(out.exitCode).toBe(0);
    const version = JSON.parse(out.stdout.toString());
    expect(version.engine).toBe("0.1.0");
    expect(version.protocol_versions).toEqual([1]);
    expect(version.pipeline_formats).toEqual(["wriven-workflow/pipeline@1"]);
    expect(version.report_version).toBe(1);
    expect(version.runtime).toStartWith("bun ");
    expect(version.target).toBe(`darwin-${process.arch}`);
  });

  test("the conformance fixtures pass against the binary", async () => {
    const results = await runConformance(CONFORMANCE_DIR, [BINARY]);
    expect(results.filter((r) => !r.passed)).toEqual([]);
    expect(results.length).toBeGreaterThan(0);
  }, 120_000);
});

describe("notices", () => {
  test("every lockfile package is listed and allowed", async () => {
    const { disallowed, lockfilePackages, readNotices, renderNotices } = await import("../scripts/notices.ts");
    const { REPO } = await import("./helpers.ts");
    const notices = readNotices(REPO);
    expect(notices.map((n) => n.name)).toEqual(lockfilePackages(REPO));
    expect(disallowed(notices)).toEqual([]);
    expect(disallowed([{ name: "x", version: "1", license: "GPL-3.0" }]).length).toBe(1);
    expect(renderNotices(notices, "1.4.3")).toContain("| typescript |");
  });
});

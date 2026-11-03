import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FakeHost } from "../src/harness/fake-host.ts";
import { DEFAULT_VALIDATION_CONTEXT, validatePipeline } from "../src/pipeline/validate.ts";
import { hostOfUrl, isPrivateAddress, urlProblem } from "../src/pipeline/urls.ts";
import { startProxy } from "../src/supervisor/proxy.ts";
import { REPO, startInProcess } from "./helpers.ts";

const TLS = join(REPO, "fixtures", "tls");
const CA = readFileSync(join(TLS, "ca.crt"), "utf8");

// Behaviour per host and path. `failures` counts down: fail that many times, then succeed.
const failures = new Map<string, number>();
let server: ReturnType<typeof Bun.serve>;
let requests: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: { key: readFileSync(join(TLS, "server.key"), "utf8"), cert: readFileSync(join(TLS, "server.crt"), "utf8") },
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push(`${url.host}${url.pathname} ua=${request.headers.get("user-agent")} accept-language=${request.headers.get("accept-language")}`);
      const left = failures.get(url.pathname) ?? 0;
      if (left > 0) {
        failures.set(url.pathname, left - 1);
        return new Response("try later", { status: 503 });
      }
      if (url.pathname === "/503") return new Response("down", { status: 503 });
      if (url.pathname === "/404") return new Response("gone", { status: 404 });
      if (url.pathname === "/redirect-out") return new Response(null, { status: 302, headers: { location: "https://evil.example/x" } });
      if (url.pathname === "/redirect-in") return new Response(null, { status: 302, headers: { location: "/final" } });
      if (url.pathname === "/redirect-loop") return new Response(null, { status: 302, headers: { location: "/redirect-loop" } });
      if (url.pathname === "/redirect-http") return new Response(null, { status: 302, headers: { location: "http://example.com/x" } });
      if (url.pathname === "/big") return new Response("x".repeat(2000));
      if (url.pathname === "/latin1") return new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), { headers: { "content-type": "text/plain; charset=windows-1252" } });
      if (url.pathname === "/slow") {
        await Bun.sleep(3000);
        return new Response("late");
      }
      return new Response(`hello from ${url.host}${url.pathname}`, { headers: { "content-type": "text/plain" } });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

const engineOptions = () => ({ test: { dial: () => ({ hostname: "127.0.0.1", port: server.port as number }), hook: { tls_ca: CA } } });

const pipeline = (fetch: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  format: "wriven-workflow/pipeline@1",
  name: "Fetch",
  input: { type: "host_trigger" },
  processors: [{ id: "fetch", type: "http_fetch", ...fetch }, { id: "note", type: "template", target: "/note", text: "{{/url}} says {{/body}}" }],
  output: { type: "host_result", title: "Fetched", body: "/note" },
  limits: { llm_calls_per_run: 0, runs_per_day: 48, run_timeout: "5m" },
  ...extra,
});

async function run(host: FakeHost, document: unknown): Promise<any> {
  const created = await host.call("stream.create", { pipeline: document });
  await host.call("stream.approve", { stream_id: created.stream_id, permissions_hash: created.permissions_hash });
  const { run_id } = await host.call("run.trigger", { stream_id: created.stream_id });
  const finished = await host.waitFor((m) => m.method === "run.finished" && m.params.report.run_id === run_id, 30_000);
  return finished.params.report;
}

const three = ["https://example.com/feed.xml", "https://blog.example.org/rss", "https://news.example.net/503"];

describe("http_fetch under the sandbox and proxy", () => {
  test("fetches through the proxy, keeps URL order, reports the numbers", async () => {
    const { host } = await startInProcess({ engine: engineOptions() });
    const report = await run(host, pipeline({ urls: ["https://example.com/a", "https://blog.example.org/b"] }));
    expect(report.status).toBe("succeeded");
    expect(report.sandbox).toBe("seatbelt");
    expect(host.results.map((r) => r.result.body)).toEqual([
      "https://example.com/a says hello from example.com/a",
      "https://blog.example.org/b says hello from blog.example.org/b",
    ]);
    expect(report.network.requests).toBe(2);
    expect(report.network.hosts).toEqual(["blog.example.org", "example.com"]);
    expect(report.network.bytes).toBeGreaterThan(0);
    expect(report.network.denied).toEqual([]);
  }, 30_000);

  test("one of three returns 503, no on_error: failed at fetch with the 503 in the message", async () => {
    const { host } = await startInProcess({ engine: engineOptions() });
    const report = await run(host, pipeline({ urls: three }));
    expect(report.status).toBe("failed");
    expect(report.error.step_id).toBe("fetch");
    expect(report.error.kind).toBe("http_status");
    expect(report.error.message).toContain("503");
    expect(host.results.length).toBe(0);
  }, 30_000);

  test("one of three returns 503, on_error skip: succeeded with one warning naming the URL", async () => {
    const { host } = await startInProcess({ engine: engineOptions() });
    const report = await run(host, pipeline({ urls: three, on_error: "skip" }));
    expect(report.status).toBe("succeeded");
    expect(report.warnings.length).toBe(1);
    expect(report.warnings[0].message).toContain("https://news.example.net/503");
    expect(report.warnings[0].step_id).toBe("fetch");
    expect(host.results.length).toBe(2);
  }, 30_000);

  test("a redirect to an unlisted host is permission_denied with that host", async () => {
    const { host } = await startInProcess({ engine: engineOptions() });
    const report = await run(host, pipeline({ urls: ["https://example.com/redirect-out"] }));
    expect(report.status).toBe("failed");
    expect(report.error.kind).toBe("permission_denied");
    expect(report.error.host).toBe("evil.example");
    expect(report.network.denied).toEqual(["evil.example"]);
    expect(requests.some((r) => r.startsWith("evil.example"))).toBe(false);
  }, 30_000);

  test("with the run's own check bypassed, the proxy refuses the same host and the report names it", async () => {
    const options = engineOptions();
    const { host } = await startInProcess({ engine: { test: { ...options.test, hook: { ...options.test.hook, bypass_allowlist_check: true } } } });
    const report = await run(host, pipeline({ urls: ["https://example.com/redirect-out"] }));
    expect(report.status).toBe("failed");
    expect(report.error.kind).toBe("permission_denied");
    expect(report.error.host).toBe("evil.example");
    expect(report.network.denied).toEqual(["evil.example"]);
    expect(requests.some((r) => r.startsWith("evil.example"))).toBe(false);
  }, 30_000);

  test("a redirect within the list is followed; a redirect loop and a redirect to http are errors", async () => {
    const { host } = await startInProcess({ engine: engineOptions() });
    const report = await run(host, pipeline({ urls: ["https://example.com/redirect-in"] }));
    expect(report.status).toBe("succeeded");
    expect(host.results[0].result.body).toContain("hello from example.com/final");
    const loop = await run(host, pipeline({ urls: ["https://example.com/redirect-loop"] }));
    expect(loop.error.kind).toBe("http_status");
    expect(loop.error.message).toContain("redirected more than 3 times");
    const plain = await run(host, pipeline({ urls: ["https://example.com/redirect-http"] }));
    expect(plain.error.kind).toBe("url_not_allowed");
  }, 30_000);

  test("retry against a server that fails twice succeeds and the report shows the attempts", async () => {
    failures.set("/flaky", 2);
    const { host } = await startInProcess({ engine: engineOptions() });
    const report = await run(host, pipeline({ urls: ["https://example.com/flaky"], retry: { max_attempts: 3, backoff: "1s" } }));
    expect(report.status).toBe("succeeded");
    expect(report.warnings.map((w: any) => w.code)).toEqual(["fetch_retry", "fetch_retry"]);
    expect(report.warnings[0].message).toContain("Attempt 1 of 3");
    expect(host.results.length).toBe(1);
  }, 30_000);

  test("no retry without retry; a 404 is not retried even with it", async () => {
    const { host } = await startInProcess({ engine: engineOptions() });
    failures.set("/once", 1);
    const before = requests.length;
    expect((await run(host, pipeline({ urls: ["https://example.com/once"] }))).status).toBe("failed");
    expect(requests.length).toBe(before + 1);
    failures.delete("/once");
    const notFound = await run(host, pipeline({ urls: ["https://example.com/404"], retry: { max_attempts: 3, backoff: "1s" } }));
    expect(notFound.status).toBe("failed");
    expect(notFound.warnings).toEqual([]);
  }, 30_000);

  test("a body over max_bytes is an error, not a truncation", async () => {
    const { host } = await startInProcess({ engine: engineOptions() });
    const report = await run(host, pipeline({ urls: ["https://example.com/big"], max_bytes: 1000 }));
    expect(report.status).toBe("failed");
    expect(report.error.kind).toBe("body_too_large");
  }, 30_000);

  test("a slow server hits timeout; the header allowlist is sent; a declared charset decodes under the sandbox", async () => {
    const { host } = await startInProcess({ engine: engineOptions() });
    const slow = await run(host, pipeline({ urls: ["https://example.com/slow"], timeout: "1s" }));
    expect(slow.error.kind).toBe("fetch_timeout");
    requests = [];
    const latin = await run(host, pipeline({ urls: ["https://example.com/latin1"], headers: { "accept-language": "en", "user-agent": "digest/1" } }));
    expect(latin.status).toBe("succeeded");
    expect(host.results.at(-1).result.body).toContain("café");
    expect(requests[0]).toContain("ua=digest/1");
    expect(requests[0]).toContain("accept-language=en");
  }, 30_000);

  test("cancel aborts an in-flight fetch", async () => {
    const { host } = await startInProcess({ engine: engineOptions() });
    const created = await host.call("stream.create", { pipeline: pipeline({ urls: ["https://example.com/slow"], on_error: "skip" }) });
    await host.call("stream.approve", { stream_id: created.stream_id, permissions_hash: created.permissions_hash });
    const { run_id } = await host.call("run.trigger", { stream_id: created.stream_id });
    await host.waitFor((m) => m.method === "run.started");
    await Bun.sleep(300);
    await host.call("run.cancel", { run_id });
    const finished = await host.waitFor((m) => m.method === "run.finished", 7000);
    expect(finished.params.report.status).toBe("cancelled");
    expect(finished.params.report.warnings).toEqual([]);
  }, 30_000);
});

describe("the proxy on its own", () => {
  const rawConnect = (port: number, request: string) =>
    new Promise<string>((resolve) => {
      let text = "";
      Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: {
          open(socket) {
            socket.write(request);
          },
          data(_socket, data) {
            text += new TextDecoder().decode(data);
          },
          close() {
            resolve(text);
          },
        },
      });
    });
  const auth = (token: string) => `Proxy-Authorization: Basic ${Buffer.from(`run:${token}`).toString("base64")}\r\n`;

  test("without the token: 407", async () => {
    const proxy = startProxy({ allowedHosts: ["example.com"], token: "secret" });
    const answer = await rawConnect(proxy.port, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
    expect(answer).toStartWith("HTTP/1.1 407");
    proxy.stop();
  });

  test("with the wrong token: 407", async () => {
    const proxy = startProxy({ allowedHosts: ["example.com"], token: "secret" });
    const answer = await rawConnect(proxy.port, `CONNECT example.com:443 HTTP/1.1\r\n${auth("wrong")}\r\n`);
    expect(answer).toStartWith("HTTP/1.1 407");
    proxy.stop();
  });

  test("an unlisted host: 403, recorded", async () => {
    const proxy = startProxy({ allowedHosts: ["example.com"], token: "secret" });
    const answer = await rawConnect(proxy.port, `CONNECT evil.example:443 HTTP/1.1\r\n${auth("secret")}\r\n`);
    expect(answer).toStartWith("HTTP/1.1 403");
    expect(proxy.denied).toEqual(["evil.example"]);
    proxy.stop();
  });

  test("another port on a listed host: 403", async () => {
    const proxy = startProxy({ allowedHosts: ["example.com"], token: "secret" });
    const answer = await rawConnect(proxy.port, `CONNECT example.com:22 HTTP/1.1\r\n${auth("secret")}\r\n`);
    expect(answer).toStartWith("HTTP/1.1 403");
    proxy.stop();
  });

  test("plain http: 405", async () => {
    const proxy = startProxy({ allowedHosts: ["example.com"], token: "secret" });
    const answer = await rawConnect(proxy.port, `GET http://example.com/ HTTP/1.1\r\n${auth("secret")}\r\n`);
    expect(answer).toStartWith("HTTP/1.1 405");
    proxy.stop();
  });

  test("a listed name that resolves to a private address: 403", async () => {
    const proxy = startProxy({ allowedHosts: ["localhost"], token: "secret" });
    const answer = await rawConnect(proxy.port, `CONNECT localhost:443 HTTP/1.1\r\n${auth("secret")}\r\n`);
    expect(answer).toStartWith("HTTP/1.1 403");
    proxy.stop();
  });
});

describe("URL rules", () => {
  const bad = ["http://example.com/", "https://1.2.3.4/", "https://[::1]/", "https://localhost/", "https://foo.local/", "https://user:pass@example.com/", "https://2130706433/", "https://0x7f.1/", "https://example.com:8443/", "https://printer/", "ftp://example.com/", "not a url", "https://localhost./"];
  for (const url of bad) test(`${url} is refused`, () => expect(urlProblem(url)).not.toBeNull());
  test("a public https name is fine; port 443 is the default", () => {
    expect(urlProblem("https://Example.com/feed?x=1")).toBeNull();
    expect(urlProblem("https://example.com:443/feed")).toBeNull();
    expect(hostOfUrl("https://Example.COM./x")).toBe("example.com");
  });
  test("validation reports url_not_allowed with a path", () => {
    const result = validatePipeline(pipeline({ urls: ["https://example.com/ok", "http://example.com/"] }), DEFAULT_VALIDATION_CONTEXT);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: "url_not_allowed", path: "/processors/0/urls/1" }));
  });
  test("a request header outside the allowlist fails validation", () => {
    const result = validatePipeline(pipeline({ urls: ["https://example.com/"], headers: { authorization: "x" } }), DEFAULT_VALIDATION_CONTEXT);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: "unknown_field", path: "/processors/0/headers/authorization" }));
  });
  test("private addresses", () => {
    for (const a of ["10.0.0.1", "127.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.1.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "100.64.0.1", "0.0.0.0"]) expect(isPrivateAddress(a)).toBe(true);
    for (const a of ["1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"]) expect(isPrivateAddress(a)).toBe(false);
  });
});

describe("sentences", () => {
  const rendered = (fetch: Record<string, unknown>) => {
    const result = validatePipeline(pipeline(fetch), { ...DEFAULT_VALIDATION_CONTEXT, clock: "host", displayName: "Wriven" });
    if (!result.valid) throw new Error(JSON.stringify(result.errors));
    return { rendered: result.rendered, permissions: result.permissions, hash: result.permissions_hash };
  };

  test("the three-host example: worked-example lines 2 and 3", () => {
    const { rendered: lines } = rendered({ urls: ["https://example.com/feed.xml", "https://blog.example.org/rss", "https://news.example.net/atom.xml"], on_error: "skip" });
    expect(lines[1]).toBe("Fetches from: blog.example.org, example.com, news.example.net (GET only, over HTTPS).");
    expect(lines[2]).toBe("Skips a source that cannot be fetched or read that day, and says so in the run report.");
  });

  test("retry renders; reordering URLs does not change the hash; one host once", () => {
    const a = rendered({ urls: ["https://a.example/1", "https://a.example/2", "https://b.example/1"], retry: { max_attempts: 3 } });
    expect(a.rendered[1]).toBe("Fetches from: a.example, b.example (GET only, over HTTPS).");
    expect(a.rendered[2]).toBe("Retries a failed fetch up to 3 times.");
    expect(a.permissions.network).toEqual([
      { host: "a.example", scheme: "https", methods: ["GET"] },
      { host: "b.example", scheme: "https", methods: ["GET"] },
    ]);
    const b = rendered({ urls: ["https://b.example/1", "https://a.example/2", "https://a.example/1"], retry: { max_attempts: 3 } });
    expect(b.hash).toBe(a.hash);
  });
});

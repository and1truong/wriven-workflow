// Entry point for `wriven-workflow --run`: the run process. Executes one pipeline once and exits.
// It reaches the world only through its parent over stdio.

import { RpcError } from "../protocol/errors.ts";
import { readLines, StdoutWriter } from "../protocol/lines.ts";
import { Peer } from "../protocol/peer.ts";
import { fixtureFetcher, proxyFetcher } from "../components/http-fetch.ts";
import { execute } from "./executor.ts";
import type { RunInit } from "./messages.ts";

export async function runMain(): Promise<void> {
  const out = new StdoutWriter();
  const cancel = new AbortController();
  const peer: Peer = new Peer({
    write: (line) => out.write(line),
    idPrefix: "r-",
    onNotification(method) {
      if (method === "cancel") cancel.abort();
    },
    async onRequest(method, params) {
      if (method !== "run") throw new RpcError("method_not_found", `There is no method named ${method}.`);
      const hook = (params as RunInit).test_hook;
      const held = hook?.allocate_mb ? Array.from({ length: hook.allocate_mb }, () => Buffer.alloc(1024 * 1024, 1)) : [];
      void held;
      if (hook?.delay_ms) await Bun.sleep(hook.delay_ms);
      const init = params as RunInit;
      const outcome = await execute(init, {
        fetcher: init.fixtures ? fixtureFetcher(init.fixtures) : init.proxy ? proxyFetcher(init.proxy, init.test_hook?.tls_ca) : null,
        network: (host, bytes) => peer.notify("network", { host, bytes }),
        denied: (host) => peer.notify("denied", { host }),
        signal: cancel.signal,
        llm: (request) => peer.request("host.llm", request).promise,
        result: (request) => peer.request("host.result", request).promise,
        warn: (warning) => peer.notify("warning", warning),
        stepStarted: (stepId) => peer.notify("step.started", { step_id: stepId }),
        stepFinished: (step) => peer.notify("step.finished", step),
      });
      // The response goes out after this returns; exit once it has reached the pipe.
      setTimeout(() => void out.flush().then(() => process.exit(0)), 0);
      return outcome;
    },
  });
  await readLines(Bun.stdin.stream(), {
    onLine: (line) => peer.receive(line),
    onOversize: () => peer.reportOversize(),
  });
  // The engine is gone. No run process outlives its parent.
  process.exit(1);
}

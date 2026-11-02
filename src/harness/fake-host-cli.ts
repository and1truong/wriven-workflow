// `wriven-workflow fake-host`: performs the handshake and prints every line both ways, or replays the
// conformance fixtures with --conformance <dir>.

import { parseArgs } from "node:util";
import { rmSync } from "node:fs";
import { makeTempStateDir, runConformance } from "./conformance.ts";
import { FakeHost, selfCommand } from "./fake-host.ts";

export async function fakeHostMain(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      conformance: { type: "string" },
      engine: { type: "string" },
      "state-dir": { type: "string" },
      verbose: { type: "boolean", default: false },
    },
  });
  const command = values.engine ? [values.engine] : selfCommand();
  if (values.conformance) {
    const results = await runConformance(values.conformance, command, values.verbose);
    for (const r of results) {
      console.log(`${r.passed ? "pass" : "FAIL"} ${r.file} (${r.duration_ms} ms)${r.error ? `: ${r.error}` : ""}`);
    }
    const passed = results.filter((r) => r.passed).length;
    console.log(`${passed}/${results.length} scenarios passed`);
    return passed === results.length && results.length > 0 ? 0 : 1;
  }

  const stateDir = values["state-dir"] ?? makeTempStateDir("wriven-workflow-fake-host-");
  const host = new FakeHost({ command, print: true });
  try {
    const init = await host.request("initialize", {
      protocol_version: 1,
      host: { name: "fake-host", version: "0", display_name: "Fake Host" },
      clock: "host",
      state_dir: stateDir,
      sandbox: "optional",
      capabilities: { llm: true, llm_reports_cost: false, results: true, live_network_in_tests: false },
    });
    if (init.error) return 1;
    await host.request("shutdown", {});
    return await host.exited;
  } finally {
    host.closeStdin();
    if (!values["state-dir"]) rmSync(stateDir, { recursive: true, force: true });
  }
}

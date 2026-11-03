// `wriven-workflow test <file>`: runs a pipeline's embedded tests against a fake host and fake world.

import { rmSync } from "node:fs";
import { loadDocument } from "../pipeline/validate-cli.ts";
import { selfCommand } from "../self.ts";
import { makeTempStateDir } from "./conformance.ts";
import { FakeHost } from "./fake-host.ts";

export async function testMain(args: string[]): Promise<number> {
  const path = args[0];
  if (!path) {
    console.error("usage: wriven-workflow test <file>");
    return 2;
  }
  let pipeline: unknown;
  try {
    pipeline = await loadDocument(path);
  } catch (err) {
    console.error(`Could not read ${path}: ${(err as Error).message}`);
    return 2;
  }
  const stateDir = makeTempStateDir("wriven-workflow-test-cli-");
  const host = new FakeHost({ command: selfCommand() });
  try {
    await host.call("initialize", {
      protocol_version: 1,
      host: { name: "cli", version: "0", display_name: "the host" },
      clock: "engine",
      state_dir: stateDir,
      sandbox: "optional",
      capabilities: { llm: true, llm_reports_cost: false, results: true, live_network_in_tests: false },
    });
    const response = await host.request("pipeline.test", { pipeline, run_embedded: true }, 600_000);
    if (response.error) {
      console.log(JSON.stringify(response.error, null, 2));
      return 1;
    }
    const { tool_result: _toolResult, ...result } = response.result;
    console.log(JSON.stringify(result, null, 2));
    return result.status === "passed" ? 0 : 1;
  } finally {
    host.closeStdin();
    await host.exited;
    rmSync(stateDir, { recursive: true, force: true });
  }
}

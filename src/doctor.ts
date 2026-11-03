// `wriven-workflow doctor`: what a host checks before offering the feature. Exit 0 only if the sandbox
// works, so a host can refuse an engine that cannot isolate without reading prose.

import { runSelfTest } from "./supervisor/self-test.ts";
import { MEASURED_WITH } from "./supervisor/seatbelt-allowances.ts";
import { versionInfo } from "./version.ts";

function signingIdentity(): string {
  const out = Bun.spawnSync(["/usr/bin/codesign", "-dv", "--verbose=2", process.execPath], { stdout: "ignore", stderr: "pipe" });
  const text = out.stderr.toString();
  const authority = /^Authority=(.+)$/m.exec(text)?.[1];
  if (authority) return authority;
  if (/^Signature=adhoc$/m.test(text)) return "ad-hoc";
  return out.exitCode === 0 ? "unknown" : "not signed";
}

export async function doctorMain(args: string[]): Promise<number> {
  const report = await runSelfTest();
  const sandbox = report.ok ? "seatbelt ok" : `not working${report.reason ? `: ${report.reason}` : ""}`;
  console.log(JSON.stringify({
    ...versionInfo(),
    binary_mb: Number((Bun.file(process.execPath).size / 1e6).toFixed(1)),
    signing: signingIdentity(),
    sandbox,
    proxy_can_bind: report.proxy_can_bind,
    allowances_measured_with: MEASURED_WITH,
    ...(args.includes("--self-test") ? { checks: report.checks } : {}),
  }, null, 2));
  return report.ok ? 0 : 1;
}

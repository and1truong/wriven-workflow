// `wriven-workflow doctor`: what a host checks before offering the feature.

import { versionInfo } from "./version.ts";

export function doctorMain(): number {
  const sandboxExec = Bun.which("sandbox-exec");
  console.log(JSON.stringify({ ...versionInfo(), sandbox_exec: sandboxExec ?? null }, null, 2));
  return sandboxExec ? 0 : 1;
}

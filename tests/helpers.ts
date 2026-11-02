// Shared by the integration tests: one compiled binary per test process, temp state directories,
// and a started-and-initialized fake host.

import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll } from "bun:test";
import { FakeHost, type FakeHostOptions } from "../src/harness/fake-host.ts";

export const REPO = resolve(import.meta.dir, "..");
export const BINARY = join(REPO, "dist", "wriven-workflow");
export const CONFORMANCE_DIR = join(REPO, "fixtures", "protocol");

const built = (() => {
  const out = Bun.spawnSync(["bun", "build", "--compile", "src/main.ts", "--outfile", BINARY], { cwd: REPO, stderr: "pipe", stdout: "pipe" });
  if (out.exitCode !== 0) throw new Error(`build failed: ${out.stderr.toString()}`);
  return BINARY;
})();

const stateDirs: string[] = [];
const hosts: FakeHost[] = [];

afterAll(async () => {
  for (const host of hosts) {
    host.closeStdin();
    await Promise.race([host.exited, Bun.sleep(12_000)]);
    if (host.exitCode === null) host.kill();
  }
  hosts.length = 0;
  for (const dir of stateDirs) rmSync(dir, { recursive: true, force: true });
  stateDirs.length = 0;
});

export function stateDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wriven-workflow-test-")));
  chmodSync(dir, 0o700);
  stateDirs.push(dir);
  return dir;
}

export function initParams(dir: string, overrides: Record<string, unknown> = {}) {
  return {
    protocol_version: 1,
    host: { name: "test", version: "0", display_name: "Wriven" },
    clock: "host",
    state_dir: dir,
    sandbox: "required",
    capabilities: { llm: true, llm_reports_cost: false, results: true, live_network_in_tests: false },
    ...overrides,
  };
}

export function spawnHost(options: Partial<FakeHostOptions> = {}): FakeHost {
  const host = new FakeHost({ command: [built], ...options });
  hosts.push(host);
  return host;
}

export async function startHost(
  options: Partial<FakeHostOptions> & { init?: Record<string, unknown> } = {},
): Promise<{ host: FakeHost; dir: string; init: any }> {
  const dir = stateDir();
  const { init: overrides, ...hostOptions } = options;
  const host = spawnHost(hostOptions);
  const init = await host.call("initialize", initParams(dir, overrides));
  return { host, dir, init };
}

// Every descendant of a process, from `ps`.
export function descendants(pid: number): number[] {
  const out = Bun.spawnSync(["/bin/ps", "-A", "-o", "pid=,ppid="]).stdout.toString();
  const children = new Map<number, number[]>();
  for (const line of out.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (child === undefined || parent === undefined || Number.isNaN(child)) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const found: number[] = [];
  const walk = (p: number) => {
    for (const c of children.get(p) ?? []) {
      found.push(c);
      walk(c);
    }
  };
  walk(pid);
  return found;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

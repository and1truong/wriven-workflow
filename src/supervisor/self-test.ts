// `doctor --self-test`: runs a child under a real profile and tries everything the profile forbids.

import { dlopen, FFIType, ptr } from "bun:ffi";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { selfCommand } from "../self.ts";
import { generateProfile, probeSandbox, programPaths } from "./seatbelt.ts";

export type Outcome = "denied" | "allowed" | "absent";

export interface CheckResult {
  name: string;
  expected: "denied" | "allowed";
  outcome: Outcome;
  detail: string;
  ok: boolean;
}

interface ChildArgs {
  home: string;
  tmp: string;
  sentinel: string;
  stateFile: string;
  manifest: string;
  tempDir: string;
  allowedPort: number;
  stamp: string;
  parentPid: number;
  bystanderPid: number;
}

function classify(err: unknown): { outcome: Outcome; detail: string } {
  const code = (err as NodeJS.ErrnoException)?.code;
  const detail = `${code ?? ""} ${(err as Error)?.message ?? err}`.trim();
  return { outcome: code === "ENOENT" ? "absent" : "denied", detail };
}

async function attempt(action: () => unknown | Promise<unknown>): Promise<{ outcome: Outcome; detail: string }> {
  try {
    await action();
    return { outcome: "allowed", detail: "" };
  } catch (err) {
    return classify(err);
  }
}

function connect(hostname: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })), 3000);
    Bun.connect({
      hostname,
      port,
      socket: {
        open(socket) {
          clearTimeout(timer);
          socket.end();
          resolve();
        },
        connectError(_socket, error) {
          clearTimeout(timer);
          reject(error);
        },
        data() {},
      },
    }).catch((err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// Another process's argv and environment, through sysctl(KERN_PROCARGS2).
function readProcessArguments(pid: number): void {
  const libc = dlopen("libSystem.B.dylib", {
    sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  });
  const CTL_KERN = 1;
  const KERN_PROCARGS2 = 49;
  const mib = new Int32Array([CTL_KERN, KERN_PROCARGS2, pid]);
  const buffer = new Uint8Array(1 << 18);
  const length = new BigUint64Array([BigInt(buffer.length)]);
  if (libc.symbols.sysctl(ptr(mib), 3, ptr(buffer), ptr(length), null, 0n) !== 0) throw Object.assign(new Error("sysctl refused"), { code: "EPERM" });
}

// Runs inside the sandbox. Writes one JSON line of outcomes.
export async function selfTestChild(argument: string): Promise<number> {
  const args = JSON.parse(argument) as ChildArgs;
  const { linkSync, readFileSync, symlinkSync, writeFileSync: write } = await import("node:fs");
  const outcomes: Record<string, { outcome: Outcome; detail: string }> = {
    read_ssh_key: await attempt(() => readFileSync(join(args.home, ".ssh", "id_rsa"))),
    read_outside: await attempt(() => readFileSync(args.sentinel)),
    read_manifest: await attempt(() => readFileSync(args.manifest)),
    write_manifest: await attempt(() => write(args.manifest, "{}")),
    link_outside: await attempt(() => linkSync(args.sentinel, join(args.tempDir, "linked"))),
    read_through_symlink: await attempt(() => {
      symlinkSync(args.sentinel, join(args.tempDir, "symlink"));
      readFileSync(join(args.tempDir, "symlink"));
    }),
    read_process_arguments: await attempt(() => readProcessArguments(args.parentPid)),
    signal_other_process: await attempt(() => process.kill(args.bystanderPid, "SIGCONT")),
    write_desktop: await attempt(() => write(join(args.home, "Desktop", `x-${args.stamp}`), "x")),
    write_tmp: await attempt(() => write(join(args.tmp, `x-${args.stamp}`), "x")),
    exec_sh: await attempt(async () => {
      const child = Bun.spawn(["/bin/sh", "-c", "exit 0"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
      if ((await child.exited) !== 0) throw Object.assign(new Error("exited non-zero"), { code: "EPERM" });
    }),
    bind_port: await attempt(() => {
      Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }).stop(true);
    }),
    connect_outside: await attempt(() => connect("1.1.1.1", 443)),
    connect_allowed_port: await attempt(() => connect("127.0.0.1", args.allowedPort)),
    write_own_temp: await attempt(() => write(join(args.tempDir, "scratch"), "x")),
    write_state_file: await attempt(() => write(args.stateFile, "{}")),
  };
  console.log(JSON.stringify(outcomes));
  return 0;
}

const EXPECTATIONS: Array<[string, string, "denied" | "allowed"]> = [
  ["read_ssh_key", "read ~/.ssh/id_rsa", "denied"],
  ["read_outside", "read a file outside the allowed paths", "denied"],
  ["read_manifest", "read the stream's manifest", "denied"],
  ["write_manifest", "write the stream's manifest", "denied"],
  ["link_outside", "hard-link an outside file into the temp directory", "denied"],
  ["read_through_symlink", "read an outside file through a symlink", "denied"],
  ["read_process_arguments", "read another process's arguments and environment", "denied"],
  ["signal_other_process", "signal another process", "denied"],
  ["write_desktop", "write ~/Desktop/x", "denied"],
  ["write_tmp", "write /tmp/x", "denied"],
  ["exec_sh", "exec /bin/sh", "denied"],
  ["bind_port", "bind a port", "denied"],
  ["connect_outside", "connect to 1.1.1.1:443", "denied"],
  ["connect_allowed_port", "connect to the allowed localhost port", "allowed"],
  ["write_own_temp", "write the private temp directory", "allowed"],
  ["write_state_file", "write the stream's state file", "allowed"],
];

export interface SelfTestReport {
  ok: boolean;
  reason: string | null;
  checks: CheckResult[];
  proxy_can_bind: boolean;
}

export async function runSelfTest(command = selfCommand()): Promise<SelfTestReport> {
  const failed = (reason: string): SelfTestReport => ({ ok: false, reason, checks: [], proxy_can_bind: false });
  const status = probeSandbox();
  if (!status.available) return failed(status.reason ?? "The sandbox is not available.");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wriven-workflow-self-test-")));
  chmodSync(root, 0o700);
  const stamp = `${process.pid}-${Date.now()}`;
  const sentinel = join(root, "outside", "sentinel");
  const tempDir = join(root, "temp");
  const stateFile = join(root, "state.json");
  const manifest = join(root, "manifest.json");
  mkdirSync(join(root, "outside"));
  mkdirSync(tempDir);
  writeFileSync(sentinel, "secret");
  writeFileSync(manifest, "{}");
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open(socket) { socket.end(); } } });
  const bystander = Bun.spawn(["/bin/sleep", "60"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const home = homedir();
  const desktopProbe = join(home, "Desktop", `x-${stamp}`);
  const tmpProbe = join(realpathSync("/tmp"), `x-${stamp}`);
  try {
    const profile = generateProfile({ programPaths: programPaths(command), tempDir, stateFiles: [stateFile], proxyPort: listener.port });
    const args: ChildArgs = { home, tmp: realpathSync("/tmp"), sentinel, stateFile, manifest, tempDir, allowedPort: listener.port, stamp, parentPid: process.pid, bystanderPid: bystander.pid };
    const child = Bun.spawn([status.path!, "-p", profile, realpathSync(command[0]!), ...command.slice(1), "--self-test-child", JSON.stringify(args)], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      cwd: tempDir,
      env: { TMPDIR: tempDir, HOME: tempDir },
    });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const code = await child.exited;
    if (code !== 0) return failed(`The child did not start under the profile (exit ${code}): ${err.trim().slice(0, 500)}`);
    const outcomes = JSON.parse(out) as Record<string, { outcome: Outcome; detail: string }>;
    const checks: CheckResult[] = EXPECTATIONS.map(([key, name, expected]) => {
      const { outcome, detail } = outcomes[key]!;
      // A missing ~/.ssh/id_rsa cannot show the read was refused, but read_outside covers that case.
      const ok = expected === "denied" ? outcome !== "allowed" : outcome === "allowed";
      return { name, expected, outcome, detail, ok };
    });
    return { ok: checks.every((c) => c.ok), reason: null, checks, proxy_can_bind: true };
  } finally {
    listener.stop(true);
    bystander.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
    // If the sandbox failed to stop these, do not leave them behind.
    for (const probe of [desktopProbe, tmpProbe]) {
      try {
        if (statSync(probe).isFile()) rmSync(probe);
      } catch {
        // Denied, as it should be: nothing to clean.
      }
    }
  }
}

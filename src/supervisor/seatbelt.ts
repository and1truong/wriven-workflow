// The Seatbelt profile for a run, generated from the pinned permissions. Deny by default; everything
// allowed is listed here or in seatbelt-allowances.ts.

import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { BASE_RULES } from "./seatbelt-allowances.ts";

export interface ProfileInput {
  // Paths of the program: the binary, plus the sources when running uncompiled.
  programPaths: string[];
  // The run's private temp directory, also its working directory.
  tempDir: string;
  // Files of the stream the run may touch. No directory: a run must not reach its manifest.
  stateFiles: string[];
  // Only set when the pipeline has network permissions.
  proxyPort: number | null;
}

export function sbplString(text: string): string {
  if (/[\0\n\r]/.test(text)) throw new Error("A path in a sandbox profile cannot contain a control character.");
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function generateProfile(input: ProfileInput): string {
  const lines = ["(version 1)", "(deny default)", ...BASE_RULES];
  for (const path of input.programPaths) {
    lines.push(`(allow process-exec (literal ${sbplString(path)}))`);
    lines.push(`(allow file-read* file-test-existence file-map-executable (subpath ${sbplString(path)}))`);
  }
  lines.push(`(allow file-read* file-test-existence file-write* (subpath ${sbplString(input.tempDir)}))`);
  for (const path of input.stateFiles) {
    lines.push(`(allow file-read* file-test-existence file-write* (literal ${sbplString(path)}))`);
  }
  lines.push("(deny process-fork)");
  lines.push("(deny network-inbound)", "(deny network-bind)");
  if (input.proxyPort !== null) lines.push(`(allow network-outbound (remote tcp ${sbplString(`localhost:${input.proxyPort}`)}))`);
  return `${lines.join("\n")}\n`;
}

export interface SandboxStatus {
  available: boolean;
  path: string | null;
  reason: string | null;
}

// Whether `sandbox-exec` is on PATH and can apply a profile on this machine.
export function probeSandbox(): SandboxStatus {
  const path = Bun.which("sandbox-exec");
  if (!path) return { available: false, path: null, reason: "sandbox-exec was not found on PATH." };
  const probe = Bun.spawnSync([path, "-p", "(version 1)(allow default)", "/usr/bin/true"], { stdout: "ignore", stderr: "pipe" });
  if (probe.exitCode !== 0) return { available: false, path, reason: `sandbox-exec failed: ${probe.stderr.toString().trim().slice(0, 300)}` };
  return { available: true, path, reason: null };
}

// What a profile must allow to re-execute this program.
export function programPaths(command: string[]): string[] {
  const paths = [realpathSync(command[0]!)];
  // Uncompiled: `bun src/main.ts`. The sources are allowed too, so development runs behave alike.
  if (command[1]) paths.push(realpathSync(dirname(dirname(command[1]))));
  return paths;
}

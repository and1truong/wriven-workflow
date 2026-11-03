// Builds both targets, re-signs and checks them, and writes the release files to dist/release:
//   bun run scripts/release.ts [--tag v0.1.0] [--identity "Developer ID Application: …"] [--notarize] [--accept-regression]
// Without --identity each binary is ad-hoc signed, which is for development only. --notarize needs
// --identity and a stored notarytool profile named by NOTARY_PROFILE.

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { COMPONENTS } from "../src/components/definitions.ts";
import { MEASURED_WITH } from "../src/supervisor/seatbelt-allowances.ts";
import { ENGINE_VERSION, PIPELINE_FORMATS, PROTOCOL_VERSIONS, REPORT_VERSION } from "../src/version.ts";
import { disallowed, readNotices, renderNotices } from "./notices.ts";

const REPO = resolve(import.meta.dir, "..");
const OUT = join(REPO, "dist", "release");
const BASELINE = join(import.meta.dir, "release-baseline.json");
const TARGETS = ["darwin-arm64", "darwin-x64"] as const;
const MAX_REGRESSION = 1.2;

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    tag: { type: "string" },
    identity: { type: "string" },
    notarize: { type: "boolean", default: false },
    "accept-regression": { type: "boolean", default: false },
    "write-baseline": { type: "boolean", default: false },
  },
});

function fail(message: string): never {
  console.error(`release: ${message}`);
  process.exit(1);
}

function run(command: string[], options: { allowFailure?: boolean; cwd?: string } = {}): { code: number; out: string; err: string } {
  const result = Bun.spawnSync(command, { cwd: options.cwd ?? REPO, stdout: "pipe", stderr: "pipe" });
  const out = result.stdout.toString();
  const err = result.stderr.toString();
  if (result.exitCode !== 0 && !options.allowFailure) fail(`${command.join(" ")} failed (${result.exitCode}): ${err || out}`);
  return { code: result.exitCode, out, err };
}

// Runs natively, or through Rosetta for the other architecture; null when this machine cannot.
function runner(target: (typeof TARGETS)[number]): string[] | null {
  if (target === `darwin-${process.arch}`) return [];
  const probe = Bun.spawnSync(["arch", "-x86_64", "/usr/bin/true"], { stdout: "ignore", stderr: "ignore" });
  return target === "darwin-x64" && probe.exitCode === 0 ? ["arch", "-x86_64"] : null;
}

function medianStartupMs(command: string[]): number {
  const times: number[] = [];
  for (let i = 0; i < 10; i++) {
    const started = performance.now();
    Bun.spawnSync([...command, "--version"], { stdout: "ignore" });
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  return Number(((times[4]! + times[5]!) / 2).toFixed(1));
}

if (values.tag && values.tag !== `v${ENGINE_VERSION}`) fail(`tag ${values.tag} does not match engine version ${ENGINE_VERSION}`);
if (values.notarize && !values.identity) fail("--notarize needs --identity");
if (values.notarize && !process.env.NOTARY_PROFILE) fail("--notarize needs NOTARY_PROFILE");

const bunVersion = Bun.version;
const pinned = readFileSync(join(REPO, ".bun-version"), "utf8").trim();
if (bunVersion !== pinned) fail(`Bun is ${bunVersion}; .bun-version pins ${pinned}`);
const commit = run(["git", "rev-parse", "--short", "HEAD"]).out.trim();
const dirty = run(["git", "status", "--porcelain"]).out.trim() !== "";
if (values.tag && dirty) fail("a tagged release needs a clean tree");

const notices = readNotices(REPO);
const bad = disallowed(notices);
if (bad.length > 0) fail(`license outside the allowlist: ${bad.map((n) => `${n.name} (${n.license})`).join(", ")}`);
const noticesText = renderNotices(notices, bunVersion);
const noticesPath = join(REPO, "THIRD_PARTY_NOTICES.md");
const noticesChanged = !existsSync(noticesPath) || readFileSync(noticesPath, "utf8") !== noticesText;
writeFileSync(noticesPath, noticesText);
if (noticesChanged) console.log("release: THIRD_PARTY_NOTICES.md changed; review and commit it");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

interface Built {
  target: string;
  archive: string;
  mb: number;
  startupMs: number | null;
  doctor: string;
  conformance: string;
  signature: string;
}

const built: Built[] = [];
for (const target of TARGETS) {
  const dir = join(OUT, target);
  mkdirSync(dir, { recursive: true });
  const binary = join(dir, "wriven-workflow");
  run(["bun", "build", "--compile", `--target=bun-${target}`, "--minify", "--sourcemap=none", `--define=BUILD_COMMIT="${commit}${dirty ? "-dirty" : ""}"`, "src/main.ts", "--outfile", binary]);

  // Always re-sign: Bun's cross-built signatures have been invalid, and two regressions were signing.
  const sign = values.identity
    ? ["codesign", "--force", "--options", "runtime", "--timestamp", "--entitlements", join(REPO, "entitlements.plist"), "--sign", values.identity, binary]
    : ["codesign", "--force", "--sign", "-", binary];
  run(sign);
  run(["codesign", "--verify", "--strict", "--verbose=2", binary]);

  if (values.identity) {
    const assess = run(["spctl", "--assess", "--type", "execute", binary], { allowFailure: true });
    console.log(`release: spctl ${target}: exit ${assess.code} (expected to fail until notarized)`);
  }
  if (values.notarize) {
    const zip = `${binary}.zip`;
    run(["ditto", "-c", "-k", "--keepParent", binary, zip]);
    const notary = run(["xcrun", "notarytool", "submit", zip, "--wait", "--keychain-profile", process.env.NOTARY_PROFILE!]);
    if (!notary.out.includes("status: Accepted")) fail(`notarization of ${target}: ${notary.out}`);
    rmSync(zip);
  }

  const archive = `wriven-workflow-${ENGINE_VERSION}-${target}.tar.gz`;
  const stage = join(dir, "stage");
  mkdirSync(stage);
  copyFileSync(binary, join(stage, "wriven-workflow"));
  copyFileSync(join(REPO, "LICENSE"), join(stage, "LICENSE"));
  copyFileSync(noticesPath, join(stage, "THIRD_PARTY_NOTICES.md"));
  cpSync(join(REPO, "fixtures", "protocol"), join(stage, "fixtures", "protocol"), { recursive: true });
  run(["tar", "-czf", join(OUT, archive), "-C", stage, "."]);

  // Check what actually ships: extract it and run that.
  const extracted = join(dir, "extracted");
  mkdirSync(extracted);
  run(["tar", "-xzf", join(OUT, archive), "-C", extracted]);
  const shipped = join(extracted, "wriven-workflow");
  const prefix = runner(target);
  let startupMs: number | null = null;
  let doctor = "not run: this machine cannot execute this architecture";
  let conformance = "not run: this machine cannot execute this architecture";
  if (prefix) {
    const version = JSON.parse(run([...prefix, shipped, "--version"]).out);
    if (version.engine !== ENGINE_VERSION) fail(`${target} reports engine ${version.engine}`);
    if (version.target !== target) fail(`${target} reports target ${version.target}`);
    startupMs = medianStartupMs([...prefix, shipped]);
    const doc = run([...prefix, shipped, "doctor"], { allowFailure: true });
    const parsed = JSON.parse(doc.out);
    if (doc.code !== 0) fail(`doctor on ${target}: ${parsed.sandbox}`);
    doctor = `exit 0, sandbox: ${parsed.sandbox}${prefix.length ? " (under Rosetta)" : ""}`;
    // Spawns the engine itself, so a fixture exercises exactly this binary.
    const replay = run([...prefix, shipped, "fake-host", "--conformance", join(extracted, "fixtures", "protocol"), "--engine", shipped], { allowFailure: true });
    conformance = replay.out.trim().split("\n").at(-1) ?? "no output";
    if (replay.code !== 0) fail(`conformance on ${target}:\n${replay.out}`);
  }
  const mb = Number((Bun.file(shipped).size / 1e6).toFixed(1));
  const signature = values.identity ? `Developer ID: ${values.identity}${values.notarize ? ", notarized" : ", not notarized"}` : "ad-hoc";
  built.push({ target, archive, mb, startupMs, doctor, conformance, signature });
  console.log(`release: ${target}: ${mb} MB, startup ${startupMs ?? "n/a"} ms, doctor ${doctor}, ${conformance}`);
  rmSync(stage, { recursive: true, force: true });
  rmSync(extracted, { recursive: true, force: true });
}

// A regression over 20% blocks the release until explained.
const measured = Object.fromEntries(built.map((b) => [b.target, { mb: b.mb, startup_ms: b.startupMs }]));
if (existsSync(BASELINE) && !values["accept-regression"]) {
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
  for (const b of built) {
    const base = baseline[b.target];
    if (!base) continue;
    if (b.mb > base.mb * MAX_REGRESSION) fail(`${b.target} is ${b.mb} MB, over 20% above the baseline of ${base.mb} MB; explain it and pass --accept-regression`);
    if (b.startupMs !== null && base.startup_ms !== null && b.startupMs > base.startup_ms * MAX_REGRESSION + 5) {
      fail(`${b.target} starts in ${b.startupMs} ms, over 20% above the baseline of ${base.startup_ms} ms; explain it and pass --accept-regression`);
    }
  }
}
if (values["write-baseline"]) writeFileSync(BASELINE, `${JSON.stringify(measured, null, 2)}\n`);

const sums = run(["shasum", "-a", "256", ...built.map((b) => b.archive)], { cwd: OUT }).out;
writeFileSync(join(OUT, "SHA256SUMS"), sums);

const adHoc = !values.identity;
writeFileSync(
  join(OUT, "release-notes.md"),
  `# wriven-workflow ${ENGINE_VERSION}

${adHoc ? "**Ad-hoc signed, developer use only.** macOS will refuse these binaries when downloaded by another person; a Developer ID is needed for public releases.\n\n" : ""}- Engine ${ENGINE_VERSION}, commit ${commit}${dirty ? " with uncommitted changes" : ""}
- Protocol ${PROTOCOL_VERSIONS.join(", ")}; pipeline formats ${PIPELINE_FORMATS.join(", ")}; report version ${REPORT_VERSION}
- Bun ${bunVersion}
- Components: ${COMPONENTS.map((c) => c.type).join(", ")}
- Seatbelt allowances last measured ${MEASURED_WITH.date} on macOS ${MEASURED_WITH.macos}, ${MEASURED_WITH.arch}, Bun ${MEASURED_WITH.bun}

Measured on the release machine, ${new Date().toISOString().slice(0, 10)}, ${process.platform}-${process.arch}:

| Target | Size | Startup (\`--version\`, median of 10) | Doctor | Conformance | Signature |
| --- | --- | --- | --- | --- | --- |
${built.map((b) => `| ${b.target} | ${b.mb} MB | ${b.startupMs === null ? "not measured" : `${b.startupMs} ms`} | ${b.doctor} | ${b.conformance} | ${b.signature} |`).join("\n")}
`,
);
console.log(`release: done, see ${OUT}`);

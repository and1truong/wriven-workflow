# Packaging and release

Source: [intent and grilling record](../inbox/2026W45/wriven-workflow.md) (decisions 3, 10), [ADR 001](../decisions/001-runtime-bun.md), [runtime research](../research/research-runtime.md) (read and measured 2026-11-03). Stage: **Design — spec**.

## Scope

How the engine is built into one executable per architecture, signed, checked, versioned and published, and what a host needs to install it. Where the binary lives inside a host's distribution is the host's question and is listed in [open-questions](../open-questions.md).

## Observable behaviour

- A release is a set of files: `wriven-workflow-<version>-darwin-arm64.tar.gz`, `wriven-workflow-<version>-darwin-x64.tar.gz`, `SHA256SUMS`, and `release-notes.md`. Each archive contains one executable, `LICENSE`, `THIRD_PARTY_NOTICES.md`, and `fixtures/protocol/` for host conformance testing.
- The executable runs with no installation step beyond `chmod +x`; it needs no Node, Bun or npm on the machine, and it reads no configuration files on start.
- `wriven-workflow --version` prints `{ "engine": "0.1.0", "protocol_versions": [1], "pipeline_formats": ["wriven-workflow/pipeline@1"], "report_version": 1, "runtime": "bun 1.4.x", "target": "darwin-arm64", "commit": "…" }`.
- `wriven-workflow doctor` prints whether `sandbox-exec` is present and whether a minimal Seatbelt profile compiles and enforces (it tries to read a denied path and connect to a denied port from a child), whether the proxy can bind, and the sizes and versions above. Exit code 0 only if the sandbox works, so a host can refuse to install an engine that cannot isolate.
- Every binary is code-signed. On a developer machine with no Developer ID, it is ad-hoc signed; a release built in CI with a Developer ID certificate is signed with it and notarized. The signing identity is printed by `doctor`.

## Build

- Toolchain: Bun, pinned in `.bun-version` and checked by the release script. It is 1.4.3 today, what Hong's machine has; this spec first said ≥ 1.4.4 and nothing yet shows 1.4.4 is needed. Rationale and alternatives in [ADR 001](../decisions/001-runtime-bun.md).
- Command (indicative): `bun build --compile --target=bun-darwin-arm64 --minify --sourcemap=none src/main.ts src/run.ts --outfile dist/wriven-workflow`. Any file that becomes a Worker or a child entry must be listed explicitly; Bun does not auto-detect them (measured 2026-11-03). v0 has no Worker; the run process is the same binary re-executed with `--run`, so only `main.ts` is an entrypoint unless the structure changes.
- Cross-build for x64 from an arm64 host works (`--target=bun-darwin-x64`), but the resulting binary's signature was invalid on Bun 1.4.3 and must be re-signed (measured 2026-11-03). CI always re-signs both targets regardless.
- No native addons. Every dependency must be pure JavaScript/TypeScript; the list is in `THIRD_PARTY_NOTICES.md` with licenses. Target: zero runtime dependencies beyond Bun's built-ins for v0 (cron parsing, feed parsing, JSON Pointer, the proxy and the Seatbelt profile are small enough to own).
- Embedded assets: the JSON Schemas for the pipeline format and the report, the tool descriptions, and the sentence templates are imported as modules so they are inside the binary and versioned with it.

Runtime dependencies: none. Dev dependencies, for type-checking only and listed in `THIRD_PARTY_NOTICES.md`: `typescript` (Apache-2.0) and `@types/bun` (MIT), with what they pull in. The executable contains none of their code.

## Signing and notarization (macOS)

Read on 2026-11-03 from Bun's signing guide and community notarization guides; Apple's pages did not render for the research agent, so Apple's exact wording is **not verified**.

1. Entitlements file with `com.apple.security.cs.allow-jit`, `com.apple.security.cs.allow-unsigned-executable-memory`, `com.apple.security.cs.disable-executable-page-protection` (Bun's documented set; a JIT runtime needs the first two at minimum; measured: all three Bun/Deno/Node binaries ran under hardened runtime with `allow-jit` + `allow-unsigned-executable-memory`).
2. `codesign --force --options runtime --timestamp --entitlements entitlements.plist --sign "Developer ID Application: …" dist/wriven-workflow`.
3. `codesign --verify --strict --verbose=2` and `spctl --assess --type execute` (the latter fails until notarized; recorded, not fatal in CI before notarization).
4. `ditto -c -k --keepParent dist/wriven-workflow dist/wriven-workflow.zip`, `xcrun notarytool submit --wait`, check the log for issues.
5. A bare executable cannot be stapled; Gatekeeper checks notarization online on first run. If the host later ships a `.app`, the engine inside it is stapled with the app.

Without a Developer ID (Hong's machine today has only an Apple Development identity, checked 2026-11-03), step 2 uses `--sign -` (ad-hoc). Ad-hoc binaries run locally, including under `sandbox-exec`, but macOS will refuse them when downloaded by another person. That is fine for development and for a host that builds the engine itself; it blocks public releases until a Developer ID exists ([open-questions](../open-questions.md)).

Signature stability matters for the host, not the engine: Wriven's Keychain "Always Allow" is bound to Wriven's signature, and the engine never touches the Keychain. Changing the engine's identity has no Keychain effect.

Measured 2026-11-03 on macOS 27.0.1, arm64: an ad-hoc signature with `--options runtime` and `entitlements.plist` keeps everything working, JIT and the `bun:ffi` call behind `engine.lock` included (`doctor` exit 0, 10/10 conformance). A real Developer ID, `spctl` and `notarytool` have not been run; there is no Developer ID, and the CI workflow has not run either because Actions quota for private repositories is used up.

## Versioning

- Engine version: semantic versioning, `0.x` during v0. The protocol, format and report versions are separate integers inside the binary; the engine's minor version bumps when any of them gains an optional field, its major when any of them changes incompatibly.
- `release-notes.md` lists, per release: engine version; protocol/format/report versions; components added or changed; measured binary sizes and startup time on the release machine; the Bun version; the list of Seatbelt allowances changed (ticket 04 keeps this list in `src/supervisor/seatbelt-allowances.ts` with the Bun version it was measured against).

## Checks before a release

- `bun test` green, including protocol conformance fixtures replayed through `fake-host`.
- `wriven-workflow doctor` exit 0 on a clean macOS user account on both architectures (x64 under Rosetta is acceptable for the check if no Intel machine is available; record which). The release script runs it on what it can execute and says "not run" in the notes otherwise, which is the x64 result on Hong's machine today because Rosetta is not installed there (checked 2026-11-03). A second, unmeasured architecture is shippable for development and is not for a public release.
- Binary size and startup recorded against `scripts/release-baseline.json`; a regression over 20% blocks the release until explained (`--accept-regression`).
- `THIRD_PARTY_NOTICES.md` regenerated and diffed.
- Checksums generated; archives extracted and `--version` compared with the tag.

## Installation by a host

A host has three options; the engine supports all, the choice is the host's:

1. **Bundled**: the host ships the binary inside its own distribution and spawns it by absolute path. Simplest, and the one Wriven would use once it has a `.app`; today Wriven is a bare executable with no bundle, so "inside" has no location yet.
2. **User-installed**: like the Codex CLI, the person installs the engine on `PATH` and the host finds it. Inherits Wriven's known `PATH`-under-Finder limitation.
3. **Downloaded by the host** on first use, with checksum verification against a pinned value in the host. Requires notarization to be useful.

In every case the host should run `wriven-workflow --version` and compare protocol versions before `initialize`, and `doctor` before offering the feature.

## Decisions and reasons

1. **Bun compile.** See [ADR 001](../decisions/001-runtime-bun.md): 59.5 MB, 7 ms startup, MIT, maintained by a team with a stated long-term commitment; Deno rejected after its runtime's end-of-development announcement; Node SEA rejected as still experimental and twice the size.
2. **Re-sign everything in CI.** Two Bun signing regressions in 2025–2026 and an invalid cross-built signature today make "trust the output" the wrong default.
3. **Zero runtime dependencies as a goal.** Each dependency enters the host's supply chain (Wriven sidecar decision 14 makes Wriven responsible for it). Cron, JSON Pointer and RSS parsing are a few hundred lines each.
4. **`doctor` with a meaningful exit code.** A host must be able to refuse to enable automations on a machine where the sandbox does not work, without reading prose.
5. **Fixtures in the archive.** The host's conformance test should not need a checkout of this repository.

## Risks

- Bun's compiled binary is "way too big" by its own docs; 60 MB inside a chat app is noticeable. Acceptable for v0; `--bytecode` did not shrink the hello world and is not used until measured on the real engine.
- Notarization needs a paid Apple developer account. Until then the engine is developer-only.
- Where the time-zone data comes from is not settled ([scheduling](scheduling.md#risks)).
- A universal (fat) binary via `lipo` is untested; two archives are shipped instead.

## Acceptance criteria

- CI produces both archives from one tag; each extracted binary prints a `--version` whose `engine` equals the tag and whose `target` matches the archive name.
- `codesign --verify --strict` passes on both binaries; with a Developer ID configured, `notarytool` reports `Accepted`.
- `doctor` exits 0 on the release machine and prints `sandbox: seatbelt ok`.
- `THIRD_PARTY_NOTICES.md` lists every package in the lockfile with a license; the build fails on a license outside an allowlist (MIT, BSD-2/3, Apache-2.0, ISC, 0BSD).
- Startup time (`--version`, median of 10) and size are in `release-notes.md`.

## Open points

- Whether to publish on npm/JSR as well as GitHub releases. A host spawns a binary, so the registry adds nothing for Wriven; useful later for `npx` developer use. Not in v0.
- Linux builds: Bun cross-compiles, but the sandbox layer is macOS-only in v0 (Seatbelt). A Linux build would run with `sandbox: optional` only. Not in v0.

# engine-11: Release builds for arm64 and x64, signing, checksums, notices, `release-notes.md`

**Spec:** [packaging-and-release](../../../specs/packaging-and-release.md), [ADR 001](../../../decisions/001-runtime-bun.md).

**To build:** A release script and CI workflow that builds both targets with pinned Bun, re-signs each (ad-hoc when no Developer ID is configured, Developer ID + hardened runtime + entitlements + timestamp when it is, with the notarization steps behind a flag), verifies with `codesign --verify --strict`, packages archives with `LICENSE`, `THIRD_PARTY_NOTICES.md` and `fixtures/protocol/`, writes `SHA256SUMS`, records sizes and `--version` startup time into `release-notes.md`, and fails on a dependency license outside the allowlist.

**Blocked by:** [engine-08](engine-08-pipeline-test-harness-inject.md) and [engine-07](engine-07-approval-update-diff.md) (a release should contain a complete v0 feature set; may be started earlier as scaffolding).

**Verification:** Acceptance criteria of [packaging-and-release](../../../specs/packaging-and-release.md#acceptance-criteria): both archives from one tag; `--version.engine` equals the tag and `target` matches the archive; `codesign --verify --strict` passes; `doctor` exit 0 on the release machine (record Rosetta use for x64 if applicable); notices list every lockfile package; sizes and startup in the notes. If a Developer ID is available by then, `notarytool` reports `Accepted`; if not, the notes say "ad-hoc signed, developer use only".

**Status:** done 2026-11-03

- [x] Build both targets; re-sign; verify
- [x] Archives, checksums, notices with license allowlist
- [x] Release notes with measurements
- [x] Notarization steps (flagged) and documentation of the no-Developer-ID path

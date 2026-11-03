// What a compiled Bun binary needs under `(deny default)`, measured, not guessed. Re-measure when the
// Bun version or the macOS major changes: `doctor --self-test` fails loudly if this list is short.
//
// Measured on 2026-11-03: macOS 27.0.1 (26A434), arm64, Bun 1.4.3, by removing rules until the
// binary stopped starting or a run stopped working (tests/sandbox.test.ts holds the workload).
//
// - dyld-support.sb is Apple's own file of "rules required to bootstrap a process with dyld". Without
//   it dyld aborts in its cache lookup. Importing it tracks OS changes to the cryptex paths, which a
//   copy of the paths here would not.
// - sysctl-read: without it the process aborts at startup. Narrowed to the prefixes below.
// - Bun needs to read its working directory, or it exits with "An unknown error occurred". The
//   supervisor makes the private temp directory the working directory.
// - /usr/share/icu stays denied, so Intl and toLocaleString throw inside a run ("Failed to format a
//   number"). Run-process code must not use them; zone arithmetic lives in the engine process.
// - No Mach lookup is needed by anything a run does; none is allowed. No dynamic-code-generation rule
//   is needed for JIT either.

export const MEASURED_WITH = { date: "2026-11-03", macos: "27.0.1 (26A434)", arch: "arm64", bun: "1.4.3" };

export const BASE_RULES = [
  '(import "dyld-support.sb")',
  '(allow sysctl-read (sysctl-name-prefix "hw.") (sysctl-name-prefix "kern.") (sysctl-name-prefix "machdep.") (sysctl-name-prefix "vm.") (sysctl-name-prefix "sysctl."))',
  '(allow file-read-data file-read-metadata file-test-existence (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))',
  '(allow file-write-data (literal "/dev/null"))',
];

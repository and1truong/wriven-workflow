# Runtime / packaging research: single-binary TS stream-processor CLI (macOS arm64 + x86_64, one worker thread per pipeline)

Research date: 2026-11-03. All web sources read on that date. Empirical numbers were measured on this
machine (macOS 27.0.1 / Apple Silicon) with Node 26.13.0 (nvm), Node 24.19.0, Bun 1.4.3, Deno 2.9.7,
using a hello-world that spawns one worker (scripts under `scratchpad/bench/`). Treat the numbers as
indicative, not benchmarks.

## Comparison table

| | Node SEA (Node 26 LTS) | Bun `build --compile` (1.4.x) | Deno `compile` (2.9.x) |
|---|---|---|---|
| Binary size, arm64 (measured, hello+worker) | 138.9 MB (Node 26.13); 114.8 MB (Node 24.19) | 59.5 MB | 64.5 MB (V8); 34.9 MB with `--engine quickjs` |
| Binary size, x86_64 cross-built (measured) | not tested (need x64 node binary; CI only tests arm64) | 75.1 MB | 76.5 MB |
| Startup, median of 10 (measured) | 33 ms (code cache made no difference here) | 7 ms (9 ms with `--bytecode`) | 14 ms (24 ms quickjs) |
| Worker inside binary | yes: `new Worker(src,{eval:true})` works; file-path workers not covered by docs | yes, but worker file must be an extra CLI entrypoint (no auto-detect) | yes, via `--include worker.ts` or static import; `--bundle` auto-detects `new Worker(new URL(...))` |
| Per-worker `resourceLimits` | yes, enforced (`ERR_WORKER_OUT_OF_MEMORY`, main survives) | accepted but ignored (`w.resourceLimits` undefined; 400 MB allocation ran to completion) | enforced through `node:worker_threads` (`ERR_WORKER_OUT_OF_MEMORY`, main survives) |
| Permission model | `--permission` stable (v22.13+/v23.5+); per-worker narrowing via `execArgv`; `--allow-net` only v25+, still experimental | none | `--allow-*`/`--deny-*` stable, scoped; per-worker `deno.permissions` (needs `--unstable-worker-options`); runtime `Deno.permissions.revoke` |
| Permissions baked into binary | yes (`execArgv` in sea-config) | n/a | yes, must be fixed at compile time; CLI flags at runtime go to the script |
| ESM / TS | ESM main needs `"mainFormat":"module"` (Node 26 docs; Node 24 docs = CJS only); TS requires bundling first | TS + ESM native | TS + ESM native |
| Signing as built (arm64) | unsigned; kernel kills it (exit 137) until `codesign --sign -` | ad-hoc signed, valid | ad-hoc signed, valid |
| Signing of cross-built x64 | n/a | invalid signature, must re-sign | valid |
| Runs under hardened runtime + JIT entitlements (ad-hoc) | yes | yes | yes |
| Maturity | Stability 1.1 "Active development" (= experimental stage) | stable product feature; 2 signing regressions in 2025-26 | stable feature; `--bundle`, `--engine quickjs`, worker permissions are unstable |

## 1. Node.js Single Executable Applications (SEA)

- LTS status: Node 26 (Lithium) is Active LTS since 2026-10-28; Node 24 moved to Maintenance 2026-10-20; Node 22 in Maintenance, EOL 2027-04-30. Latest LTS release v26.13.0.
  Sources: https://github.com/nodejs/Release and https://nodejs.org/en/about/previous-releases (read 2026-11-03).
- Still experimental: docs for v26.13.0 say "Stability: 1.1 - Active development"; the VFS subsection is "1.0 - Early development". Per the stability index, 1.x means "not recommended in production environments" and "Non-backward compatible changes or removal may occur in any future release".
  Sources: https://nodejs.org/api/single-executable-applications.html , https://nodejs.org/api/documentation.html (2026-11-03).
- ESM: supported in Node 26 via `"mainFormat": "module"` (default commonjs); cannot combine with `useSnapshot`; `import.meta.url/filename/dirname` point at `process.execPath`, `import.meta.resolve` unsupported. The Node 24 docs still say "currently only supports ... CommonJS" and have no `mainFormat`, so ESM-in-SEA needs Node 26.
  Sources: https://nodejs.org/api/single-executable-applications.html , https://nodejs.org/docs/latest-v24.x/api/single-executable-applications.html (2026-11-03). Verified: Node 26.13 built and ran an ESM main with worker + asset; Node 24 doc confirms CJS only.
- worker_threads: the SEA doc does not mention workers at all. Measured: `new Worker(code, { eval: true, resourceLimits })` works inside the SEA on Node 24 and 26. Because "module loading does not read from the file system" in the injected script and `__filename === process.execPath`, a worker that points at a file path would need that file on disk or an eval/`data:` entry; this limitation is an inference from the doc text, not stated in it. Practical pattern: bundle the worker into the same blob as a string/asset and start it with `eval: true` (or `sea.getAsset` + eval).
- Bundling/assets: SEA embeds exactly one script, so a bundler (esbuild/rollup) is required for TS and multi-file code. Assets via `"assets": {key: path}` and `sea.getAsset/getAssetAsBlob/getRawAsset/getAssetKeys` (verified). Alternative deflate-compressed `vfsArchive` (Stability 1.0). `useCodeCache` improves startup per docs; here it made no measurable difference (33 vs 34 ms). `useCodeCache`/`useSnapshot` must be off for cross-platform builds.
  Source: https://nodejs.org/api/single-executable-applications.html (2026-11-03).
- Size/startup (measured): 138.9 MB on Node 26.13 arm64, 114.8 MB on Node 24.19; 33 ms startup including worker spawn. Node is the biggest of the three because the whole `node` binary is copied.
- Build tooling: Node >= 25.5 has `node --build-sea config.json` (one step, no postject); CI-tested on macOS arm64 only ("x64 is skipped"). Older flow: `node --experimental-sea-config`, `cp node app`, `codesign --remove-signature app`, `npx postject app NODE_SEA_BLOB sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --macho-segment-name NODE_SEA`, then re-sign. Note: `--build-sea` writes the executable to the config's `output` path (measured; my blob-named output was the Mach-O).
  Source: https://nodejs.org/api/single-executable-applications.html , https://nodejs.org/api/cli.html (`--build-sea` added v25.5.0) (2026-11-03).
- Signing caveats (measured): output of both flows is unsigned ("code object is not signed at all"); running it is `Killed: 9` on Apple Silicon until `codesign --sign -`. Re-signing with `--options runtime` + `allow-jit` + `allow-unsigned-executable-memory` entitlements works. For Developer ID + notarization see "Signing/notarization" below.
- Gotcha: Homebrew's node 26.10.0 is built with `single_executable_application=false` ("Single executable application is disabled"); use official nodejs.org binaries (nvm) on the build host (measured 2026-11-03).
- x86_64: you need an x64 `node` binary to copy/inject; cross-building from arm64 is supported in the docs only with `useCodeCache`/`useSnapshot` disabled. Not tested here (unverified).

## 2. Bun `bun build --compile`

- Current stable: Bun v1.4.4, released 2026-10-22. Sources: https://github.com/oven-sh/bun/releases/latest , https://bun.com/blog/bun-v1.4.4 (2026-11-03). Local 1.4.3 used for measurements.
- Size/startup (measured): 59.5 MB arm64, 75.1 MB x64 cross-build; 7 ms startup with worker (9 ms with `--bytecode --minify`; size unchanged for this tiny app). Docs admit "Bun's binary is still way too big" and claim `--bytecode` makes `tsc` start 2x faster; bytecode supports cjs and esm with `--compile`.
  Source: https://bun.com/docs/compiler/executables (2026-11-03).
- Workers: supported, but "To use workers in a standalone executable, add the worker's entrypoint to the build"; "We may eventually detect statically-known paths" (not yet). Measured: without listing `worker.ts` the binary fails with `ModuleNotFound resolving "/$bunfs/root/worker.ts"`; with `bun build --compile main.ts worker.ts` it works. Bun's `Worker` API is documented as "still experimental (particularly for terminating workers)".
  Sources: https://bun.com/docs/compiler/executables , https://bun.com/docs/api/workers (2026-11-03).
- Per-worker limits: no `resourceLimits`; only `smol: true` (smaller JSC heap, slower). Measured: `node:worker_threads` `resourceLimits` is accepted silently, `worker.resourceLimits` is `undefined`, and a runaway allocation was not terminated.
- Cross-compile targets: bun-linux-x64/arm64 (+ -musl), bun-windows-x64/arm64, bun-darwin-x64/arm64; `-baseline/-modern` suffixes now resolve to the same binary. Windows icon/hide-console flags cannot be used when cross-compiling (except hideConsole). Source: https://bun.com/docs/compiler/executables (2026-11-03).
- ESM/TS: native, no bundler step. Assets: `import x from "./f" with { type: "file" }`, `Bun.file()`, `Bun.embeddedFiles`, `--asset-naming`. `--compile-exec-argv` embeds runtime flags into `process.execArgv`.
- macOS signing history and state:
  - Issue #7208 (opened 2023-11-18, "main executable failed strict validation"): payload appended in a way that broke Mach-O layout; closed as completed 2025-02-25 via PR #17207. Bun's guide says codesign support "requires Bun v1.2.4 or newer". Sources: https://github.com/oven-sh/bun/issues/7208 , https://bun.com/guides/runtime/codesign-macos-executable (2026-11-03).
  - Issue #29361 (2026-04-16): regression in 1.3.12 only, `LC_CODE_SIGNATURE.datasize` smaller than the SuperBlob, so `codesign --sign -` failed and binaries were `Killed: 9`; fixed by PR #29272, "first released in 1.3.13". Source: https://github.com/oven-sh/bun/issues/29361 (2026-11-03).
  - Measured on 1.4.3: native arm64 output is ad-hoc signed and valid; the x64 cross-build has an invalid signature and must be re-signed (`codesign --force --sign -` or Developer ID). Downstream projects (supertag-cli, openabcode) shipped unsigned/killed binaries in 2026 and now re-sign explicitly in CI; recommend doing the same regardless of target.
  - Official entitlements for signing: `allow-jit`, `allow-unsigned-executable-memory`, `disable-executable-page-protection`, `allow-dyld-environment-variables`, `disable-library-validation`; guide uses `codesign --entitlements entitlements.plist --deep --sign ID ./myapp --force`. Notarization is not covered by Bun docs. Source: https://bun.com/guides/runtime/codesign-macos-executable (2026-11-03).
- Permissions: Bun has no permission model.

## 3. Deno `deno compile`

- Current stable: Deno v2.9.8, released 2026-10-21 (notes include "fix(compile): check read permission for dynamically imported local files"). Source: https://github.com/denoland/deno/releases/latest (2026-11-03). Local 2.9.7 used for measurements.
- Size/startup (measured): 64.5 MB arm64 (uses the stripped `denort` runtime), 76.5 MB x64 cross-build, 34.9 MB with `--engine quickjs`; 14 ms startup with worker (24 ms quickjs). `--bundle` did not shrink this tiny app. Third-party datapoint (yao-pkg, Linux x64, Deno 2.7.12): 93 MB / 50 ms hello-world; 183 MB / 740 ms for a 9 MB CLI that pulled in all of node_modules. Source: https://yao-pkg.github.io/pkg/guide/vs-bun-deno (2026-11-03).
- Cross-compile: `--target` x86_64/aarch64-apple-darwin, x86_64/aarch64-unknown-linux-gnu, x86_64/aarch64-pc-windows-msvc; "Deno supports cross compiling to all targets regardless of the host platform" (downloads `denort-<target>.zip`). Source: https://docs.deno.com/runtime/reference/cli/compile/ (2026-11-03).
- Workers: not included by default; pass the file with `--include worker.ts` or statically import it; with `--bundle`, `new Worker(new URL("./worker.ts", import.meta.url))` is detected and bundled separately (computed URLs or workers spawned from transitive deps are dropped). Verified with `--include`.
- Permissions baked at compile time: "the runtime flags used to execute the script must be specified at compilation time. This includes permission flags." Verified: `./app --allow-read` is passed through as a script argument, not honoured. Scoped grants (`--allow-net=host`, `--allow-read=./data`, `--deny-*` overriding allow) and `--no-prompt` work. `deno.json` can hold `"compile": { "include", "exclude", "permissions" }` and named `"permissions"` sets (Deno 2.5+, selected with `-P`).
  Sources: https://docs.deno.com/runtime/reference/cli/compile/ , https://docs.deno.com/runtime/fundamentals/security/ , https://docs.deno.com/runtime/reference/deno_json/ (2026-11-03).
- Per-worker restriction (the key feature for "declared permissions per stream"): `new Worker(url, { type: "module", deno: { permissions: "none" | "inherit" | {...} } })`; "the permissions of a worker can't be extended beyond its parent's permissions reach"; default inherit. Marked unstable: requires `--unstable-worker-options` (baked at compile time, verified). Verified in a compiled binary: main thread reads `/etc/hosts`, worker with `permissions: "none"` gets `NotCapable`. Runtime `Deno.permissions.revoke/request/query` also exist; the security doc explicitly recommends isolating untrusted code in "a Web Worker with a reduced permission set". `--allow-run` and `--allow-ffi` are documented as equivalent to `--allow-all`.
  Sources: https://docs.deno.com/api/web/~/WorkerOptions.deno , https://docs.deno.com/runtime/fundamentals/security/ (2026-11-03).
- Per-worker resource limits: no native Web Worker option, but `node:worker_threads` `resourceLimits` is implemented: measured `maxOldGenerationSizeMb: 32` terminated a runaway worker with `ERR_WORKER_OUT_OF_MEMORY` and the main thread survived. Combining `resourceLimits` (node:worker_threads) with `deno.permissions` (Web Worker option) in one worker is not documented; unverified whether both apply to the same Worker object.
- Signing (measured): compiled output (native and x64 cross) is ad-hoc signed and valid; runs under hardened runtime with JIT entitlements. Docs: ad-hoc by default "equivalent to `codesign -s -`", re-sign with `codesign -s "Developer ID Application: ..."`; notarization only linked to Apple docs. Source: https://docs.deno.com/runtime/reference/cli/compile/ (2026-11-03).
- Caveats: `--bundle`, `--minify`, `--engine quickjs` (slower on compute-heavy code, "does not receive the same security updates as V8", not for untrusted input) and `--self-extracting` are experimental; by default the whole resolved `node_modules` tree is embedded (use `--bundle`, `--exclude-unused-npm`, or `--exclude`).

## 4. Other options (one line each)

- `vercel/pkg`: deprecated, "5.8.1 as the last release", repo archived 2024-01-13; points at Node 21 SEA. Source: https://github.com/vercel/pkg (2026-11-03).
- `@yao-pkg/pkg`: maintained fork, Node 22/24 targets, `--sea` mode on top of Node SEA plus a patched-node "standard" mode (71 MB / 40 ms hello-world on Linux). Source: https://yao-pkg.github.io/pkg/ , https://yao-pkg.github.io/pkg/guide/vs-bun-deno (2026-11-03).
- esbuild + Node: not a packaging option on its own; `esbuild --bundle --platform=node` produces the single CJS/ESM file SEA needs (built-ins marked external automatically). Source: https://esbuild.github.io/api/#platform (2026-11-03).
- QuickJS: only credible turnkey path is `deno compile --engine quickjs` (34.9 MB measured, experimental, no V8 security cadence, slower). Standalone quickjs-ng `qjs -c` would need Node-API shims for streams: unverified, not recommended.

## Permission model and per-worker limits: direct answers

- Deno: full permission model, scoped, baked into the binary, and narrowable per worker (`deno.permissions`, cannot widen) plus runtime `revoke`. Best fit for "declared permissions per stream". Costs: `--unstable-worker-options` flag; `--allow-run`/`--allow-ffi` punch through everything.
- Node: Permission Model is Stability 2 (stable) since v22.13/v23.5 under `--permission` (no longer `--experimental-permission`), but it is "a seat belt", "does not protect against malicious code", symlinks are followed outside granted paths, and `--allow-net` only exists from v25 (Stability 1.1). Per-worker: "The model does not inherit to a worker thread"; a worker with explicit `execArgv` gets only the flags listed, so you can narrow per worker (verified: parent fs.read /etc + net, worker only `--allow-fs-read=<its script>`, so `fs.read /etc false | net false`); the worker needs read access to its own script file, or use `eval`. Requires `--allow-worker` in the parent, which Node warns "could invalidate the permission model". Sources: https://nodejs.org/api/permissions.html , https://nodejs.org/api/worker_threads.html , https://nodejs.org/api/cli.html (2026-11-03).
- Bun: no permission model. Per-worker limits: none (`resourceLimits` ignored, measured).
- Per-worker resource limits: Node `resourceLimits` (`maxOldGenerationSizeMb`, `maxYoungGenerationSizeMb`, `codeRangeSizeMb`, `stackSizeMb`; "These limits only affect the JS engine, and no external data, including no ArrayBuffers") enforced; Deno enforces the same option via `node:worker_threads`; Bun does not. None of the three offers CPU/time limits per worker.

## Signing / notarization (all three)

- Apple Silicon kernel kills unsigned Mach-O at exec (observed as `Killed: 9` / exit 137 for Node SEA output). Ad-hoc signing is enough to run locally; for distribution you need Developer ID signing with `--options runtime` (hardened runtime) plus the JIT entitlements, a secure timestamp, zip the bare binary (`ditto -c -k --keepParent`) and `xcrun notarytool submit --wait`. Stapling a ticket to a bare CLI binary is not possible; stapling applies to .dmg/.pkg/.app. Apple's pages did not render for me, so the exact requirement wording is unverified; community sources: https://scriptingosx.com/2019/09/notarize-a-command-line-tool/ , https://www.randomerrata.com/articles/2024/notarize (2026-11-03). Verified locally that all three binaries run after `codesign --options runtime --entitlements` with `allow-jit` + `allow-unsigned-executable-memory`.
- Universal (fat) binary: `lipo -create` of the arm64 and x64 outputs should work for Bun/Deno outputs; not tested (unverified). Node SEA x64 needs an x64 node binary on the build host.

## Recommendation for this use case

Pick Deno `deno compile` if the "declared permissions per stream" design is a real product feature: it is the only runtime where permissions are both baked into the binary and narrowable per worker (and revocable at runtime), it enforces per-worker heap limits through `node:worker_threads`, cross-compiles to macOS x64 from arm64 with a valid signature, and ships a 65 MB / 14 ms binary with native TS/ESM. Trade-off: the worker-permission option is still `--unstable-worker-options`, Node-compat is good but not Node (test every npm dep you rely on, especially native addons and anything using `fs` fds), and `--allow-run`/`--allow-ffi` must stay off.

Pick Bun if raw startup/throughput and the smallest V8-free binary matter more than the permission model: 60 MB / 7 ms, native TS, trivial build. You give up any permission model and per-worker memory limits (you would have to run pipelines as child processes to cap them), you must list every worker file on the CLI, and you must re-sign in CI (two signing regressions in the past 18 months; cross-built x64 output has an invalid signature today).

Node SEA is the conservative runtime but the weakest packaging story here: still Stability 1.1 even in Node 26 LTS, 115-139 MB, must bundle first, output is unsigned and dies until signed, ESM only on Node 26, x64 requires a second build host or disabled code cache. Choose it only if Node-exact compatibility outweighs all of that; its permission model does allow per-worker narrowing via `execArgv`, but it is explicitly not a security boundary.

## Unverified

- Node SEA: behaviour of file-path workers (`new Worker('./w.js')`) inside the SEA; x86_64 SEA build from an arm64 host (docs say disable code cache/snapshot; CI skips macOS x64).
- Node `--permission` applying to SEA execArgv-embedded flags and whether `--allow-worker` + per-worker `execArgv` narrowing is intended to be relied on (doc says "intended, not a bypass", but model is "not a security boundary").
- Deno: whether `resourceLimits` (node:worker_threads) and `deno.permissions` (Web Worker) can be combined on one worker; exact startup/size for a realistic bundle with npm deps; stapling/notarization of bare binary tested only via community guides.
- Bun: whether ad-hoc signing of native arm64 output is guaranteed by policy (observed on 1.4.3; downstream reports say some 1.3.x versions shipped unsigned); release date year of v1.4.4 taken from the blog post (2026-10-22).
- Apple notarization requirement wording (hardened runtime, timestamp): developer.apple.com pages did not render; taken from community guides.
- yao-pkg numbers are the project's own, measured on Linux x64 with older runtime versions.
- Universal binary via `lipo` for Bun/Deno outputs.

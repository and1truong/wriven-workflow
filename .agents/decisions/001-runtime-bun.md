# ADR 001: Runtime and packaging — Bun, `bun build --compile`

Date: 2026-11-03. Status: accepted (Hong, grilling round 2). Supersedes the round-1 recommendation (Deno).

## Context

The engine is TypeScript and must ship as one self-contained executable for macOS arm64 and x64, be spawned by a Swift host, start fast, and support process-level isolation of runs. Three options were researched and measured on Hong's machine on 2026-11-03 ([research](../research/research-runtime.md)): Node SEA, Bun compile, Deno compile. A fourth, using macOS's system `JavaScriptCore.framework` from Swift, was raised by Hong.

Facts that decided it:

- **Deno**: on 2026-10-09 Deno announced its team is joining Cloudflare; the runtime gets one year of monthly maintenance releases, after which "we've decided to put our future development work into this shared platform rather than continuing to develop a separate runtime"; it stays open source and others are welcome to continue it ([deno.com/blog/cloudflare](https://deno.com/blog/cloudflare), read 2026-11-03). Deno Deploy shuts down in six months; JSR continues on Cloudflare infrastructure. Technically Deno was the best fit (baked permissions, per-worker permission narrowing, enforced worker heap limits, 64.5 MB, 14 ms), but a new project should not stand on a runtime with an announced end of development.
- **Bun**: acquired by Anthropic on 2025-12-02 with the statements "Bun stays open-source & MIT-licensed", "the same team still works on Bun", "safely bet their stack on Bun" ([bun.com/blog/bun-joins-anthropic](https://bun.com/blog/bun-joins-anthropic), read 2026-11-03). Current 1.4.4. Measured: 59.5 MB arm64, 7 ms startup, native TS/ESM, cross-build to x64 works but its signature was invalid and must be re-signed. Weaknesses measured: no permission model; `resourceLimits` on workers accepted and ignored (a runaway worker was not terminated); workers in compiled binaries must be listed as entrypoints. Bun runs on JavaScriptCore built from its own WebKit fork, not the system framework, and its docs now say it is written in Rust ([contributing page](https://bun.com/docs/project/contributing), read 2026-11-03).
- **Node SEA**: Node 26 is Active LTS, but SEA is still Stability 1.1 "Active development"; 115–139 MB; output unsigned and killed on Apple Silicon until signed; ESM main only on Node 26; x64 build needs an x64 node binary. Permission model is "not a security boundary" per Node's own docs.
- **System JavaScriptCore via Swift**: available on every Mac through `JSContext`, but it is an engine only: no event loop, `fetch`, timers, file or process APIs, no workers. Building a runtime around it is what Bun spent years doing, and it would mean embedding a JS runtime into the host, which the brief excludes.

## Decision

Bun, compiled with `bun build --compile`, one binary per architecture, always re-signed in CI. Isolation does not come from the runtime; it comes from the OS ([ADR 004](004-isolation-process-seatbelt-proxy.md)).

## Consequences

- Smallest and fastest binary of the three; native TypeScript; a maintainer with a public long-term commitment.
- Every isolation and resource-limit requirement moves to process boundaries and macOS Seatbelt. There is no in-process permission model to lean on.
- Worker files and child entrypoints must be listed explicitly at build time. v0 avoids Workers entirely (the run process is the same binary re-executed).
- Node-compat testing is still needed for any npm dependency; the zero-dependency goal reduces this.
- Signing regressions have happened twice in 18 months; CI verifies signatures on every build.
- Re-evaluate if Bun's ownership or license changes, or if Apple's Seatbelt disappears and an in-runtime permission model becomes the only isolation available.

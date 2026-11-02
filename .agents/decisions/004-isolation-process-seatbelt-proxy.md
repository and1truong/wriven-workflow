# ADR 004: Isolation by run-scoped child process, macOS Seatbelt profile and an allowlisting proxy

Date: 2026-11-03. Status: accepted (Hong, grilling round 2, Q11). Supersedes the round-1 recommendation (one Deno Worker per stream with narrowed permissions).

## Context

With Bun ([ADR 001](001-runtime-bun.md)) there is no in-runtime permission model and worker resource limits are not enforced (measured 2026-11-03). Isolation must come from the operating system. Hong asked whether macOS's sandbox and Anthropic's `sandbox-runtime` could be used.

Facts read on 2026-11-03:

- `sandbox-exec` (Seatbelt) exists on macOS. Its man page says "The sandbox-exec command is DEPRECATED" and points to App Sandbox; the profile language (SBPL) is not documented by Apple. Codex CLI uses it today: it generates an SBPL profile in memory and passes it with `-p`; network under Seatbelt is all-or-nothing, with no domain filtering ([write-up](https://codex.danielvaughan.com/2026/05/03/codex-cli-sandbox-internals-seatbelt-bubblewrap-landlock-windows-dacl/), updated 2026-11-02). Whether `sandbox-exec` still works on Hong's macOS was not tested in this session (Hong declined the probe); inferred from Codex and `srt` depending on it.
- [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime) (`srt`, Apache-2.0, "Beta Research Preview", built for Claude Code): on macOS uses `sandbox-exec` with generated Seatbelt profiles and solves domain filtering by running HTTP and SOCKS5 proxies on the host; the profile allows the sandboxed process to connect only to the proxies' localhost ports. Usable as a library (`SandboxManager`), needs Bun ≥ 1.4 for TLS termination, and requires `ripgrep` installed on the machine. Its README lists limits: domain filtering is not content inspection, domain fronting may bypass it, Unix sockets are blocked by default.
- App Sandbox (entitlements) requires a signed `.app` bundle. Wriven is a bare executable today.

## Decision

- **Unit of isolation is a run.** The engine spawns one child process per run (`wriven-workflow --run`, the same binary), wrapped in `sandbox-exec -p <profile>`. The process exits when the run's report is sent.
- **Seatbelt profile is generated from the pinned permissions** ([permissions](../specs/permissions.md#from-permissions-to-enforcement)): deny by default; read the binary, the enumerated system paths a Bun process needs, and the stream's own state directory; write only that directory and a private temp; deny `process-exec`/`process-fork`; deny inbound network and binding; allow outbound only to `localhost:<proxy_port>`.
- **The engine runs an egress proxy** on `127.0.0.1` with an ephemeral port and a per-run token. It accepts `CONNECT host:443` only for hosts in the run's allowlist, refuses the rest with 403 and reports `permission_denied`. No TLS inspection.
- **`host_llm` never touches the network**: it is a message to the engine over the child's stdio, forwarded to the host.
- **Memory and time** are enforced by the engine's supervisor: RSS sampling against a ceiling, `run_timeout`, then `SIGKILL` to the process group.
- **Own implementation, `srt` and Codex as references.** The profile generator and proxy are a few hundred lines; `srt` is a research preview with API churn and a `ripgrep` dependency on the person's machine, which a bundled engine should not require.
- **Never silent.** `initialize` reports sandbox availability; every permissions rendering ends with the sandbox status; `sandbox: required` (default) refuses runs without it; `doctor` exits non-zero without it.

## Consequences

- Isolation is as strong as Seatbelt plus the proxy, which is the same boundary Codex CLI and Claude Code rely on today. It is not App Sandbox; the engine process itself is unsandboxed.
- Process spawn per run (tens of milliseconds) instead of worker reuse. Acceptable for runs measured in seconds.
- The list of Seatbelt allowances a Bun binary needs to start must be measured, not guessed, and re-measured per Bun version (Codex's `configd` Mach-lookup crash is the cautionary example). Ticket 04 owns this list.
- If Apple removes `sandbox-exec`, the engine degrades to "engine's own checks only" and says so; the upgrade path is an App Sandbox helper once a `.app` exists.
- Linux has no equivalent in v0; a Linux build would run `sandbox: optional` only.

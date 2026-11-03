# engine-04: Runs execute under a generated Seatbelt profile with memory and time watchdogs

**Spec:** [permissions](../../../specs/permissions.md#from-permissions-to-enforcement), [architecture](../../../specs/architecture.md), [threat-model](../../../specs/threat-model.md) (T4, T9, T11, T12), [ADR 004](../../../decisions/004-isolation-process-seatbelt-proxy.md).

**To build:** The supervisor wraps the run process in `sandbox-exec -p <profile>`; the profile is generated from the pinned permissions: deny default, read allowances for the binary and the measured set of system paths and Mach services a Bun binary needs, read/write of the stream's state directory and a private temp, deny `process-exec`/`process-fork`, deny inbound and bind, outbound only to a given localhost port (unused until engine-05). Allowances live in one file with the Bun version they were measured against. RSS sampling against `run_memory_mb` and `run_timeout` with `SIGKILL` to the process group. `initialize` reports sandbox availability; `sandbox: required|optional` honoured; `doctor --self-test` runs a child under the profile and tries forbidden operations. Permission sentences gain the final "OS sandbox: …" line.

**Blocked by:** [engine-03](engine-03-minimal-run-host-llm-host-result.md).

**Verification:** `doctor --self-test` exit 0 on Hong's Mac with: read `~/.ssh/id_rsa` denied, write `~/Desktop/x` denied, exec `/bin/sh` denied, bind denied, connect `1.1.1.1:443` denied, connect to the allowed localhost port allowed. A run that allocates past the ceiling → `failed`, reason `memory_limit`, engine survives; a run that sleeps past `run_timeout` → `timed_out`. Fixture 10 (`sandbox-exec` absent via `PATH`, `required` → `sandbox_unavailable`; `optional` → runs with `sandbox: none` and the changed sentence). The measured allowance list is committed with the Bun version. **Record the macOS version and whether `sandbox-exec` printed a deprecation warning**; this is the first time it is exercised in this project.

**Status:** done 2026-11-03

- [x] Profile generator; measured allowances file
- [x] Supervisor wrap, process group, kill
- [x] RSS and timeout watchdogs
- [x] `sandbox` policy at `initialize`; sentence line; `doctor --self-test`
- [x] Fixture 10; macOS version and observations recorded in the spec

# example-host-01: `stream.get` returns the diff of a waiting update

**Spec:** [example-host](../specs/example-host.md) (decision 8, "Changes to other specs"), [host-protocol](../specs/host-protocol.md) (`stream.get`).

**To build:**
- **Engine.** When a stream has a widening update waiting, `stream.get` returns `pending.diff: { added, removed }`, computed with the same `sentenceDiff` call `stream.update` uses (`src/engine/engine.ts`), so the two can never disagree. A new stream waiting for its first approval has no `pending` and no `diff`, as today.
- **Example host.** `approvalCard` takes `pending.diff` from the engine and drops its own set difference.
- **Spec updates:** [host-protocol](../specs/host-protocol.md) (`stream.get` result and its note), [docs/host-integration.md](../../docs/host-integration.md) (the restart sentence: "`stream.get` returns `pending` with its `diff`").

**Blocked by:** nothing.

**Verification:**
- An engine test: approve a stream, widen it with `stream.update`; `stream.get`'s `pending.diff` deep-equals the `diff` of the `stream.update` result. Approving clears `pending`.
- `bun run test:example`: the widening test still shows "at most 3 requests per run" under `added`, now from the engine.
- `bun test` and both typechecks pass.

**Status:** open

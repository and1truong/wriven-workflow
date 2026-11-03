# composition-09: `workflow`

**Spec:** [composition](../../../specs/composition.md#workflow) (`workflow`, permissions, run report). Grilling decisions 6 and 16.

**To build:**
- **Branches.** `id`, `from`, `steps`, `result`, `target`, `after`; 1–16 per workflow.
  - The child is built from the parent as it is when the branch starts, keeps the parent's id, and copies `meta`.
  - Branch steps must preserve ids (`changes_message_ids`).
- **Dependencies.**
  - Inferred from an explicit `from` overlapping another branch's `target` (prefix either way), plus `after`. A branch without `from` gets no inferred dependencies.
  - `cycle` and `write_conflict` at validation.
  - Each branch validates against the parent's shape at the start plus its dependencies' targets.
  - Target shapes are inferred from the branch's steps.
- **Execution.**
  - Branches with no path between them run concurrently. Their `host_llm` calls share `llm_concurrency`.
  - A missing `from`, or a child dropped in the branch, skips that parent: the target is unwritten, and dependents skip it too.
  - Output in input order.
- **Run report.** `skipped` per branch.
- **Permissions.** An `http_fetch` in any branch of the same workflow sets `receives_fetched_content` for a `host_llm` in any other branch.
- **Conformance case 11**, moved here from composition-04: a host declaring `llm_concurrency: 2` and holding calls sees two `host.llm` requests from two branches before answering either; fixture, README entry, and the count in `tests/conformance-kit.test.ts`.
- **Spec updates.**
  - [pipeline-format](../../../specs/pipeline-format.md): `workflow`, `cycle`, `write_conflict`.
  - [host-protocol](../../../specs/host-protocol.md): conformance scenario 11.
  - [permissions](../../../specs/permissions.md): the derivation rule.

**Blocked by:** [composition-04](completed/2026w45/composition-04-concurrent-host-llm.md), [composition-08](completed/2026w45/composition-08-while.md) (for `changes_message_ids`).

**Verification:**
- **Execution:**
  - the spec's three-branch example runs `classify` and `translate` concurrently (peak 2 outstanding against the fake host with `llm_concurrency: 2`), then `headline`, and writes all three targets;
  - B with `from` equal to A's `target` runs after A.
- **Validation:**
  - adding `after: ["B"]` to A gives `cycle`;
  - targets `/a` and `/a/b` give `write_conflict`;
  - a branch reading a sibling's target without `from` or `after` gives `unresolved_pointer`.
- **Skips:** a `filter` dropping one parent leaves its target unwritten; a dependent skips it too, and the report shows `skipped: 1` for both.
- **Regression:** v0 example hashes are unchanged.

**Status:** done 2026-11-03

- [x] Branch schema, child construction, write-back (`src/pipeline/workflow.ts` holds the dependency graph shared by validation and the run)
- [x] Dependency inference, `cycle`, `write_conflict`, per-branch shapes
- [x] Concurrent tiers, skips, report (`branches` on the workflow step's report entry)
- [x] Permission rule; conformance scenario 11; specs updated (pipeline-format, permissions, host-protocol)

Notes:
- A failure that leaves a branch (to an outer `try`, or ending the run) also removes its parent message from the workflow's output, so a caught message is never delivered twice under one id.
- After a `cycle` or an `after` that names no sibling, validation stops checking what follows the workflow (its output shape is `unknown`), so errors point at the cause only.
- When a branch id repeats a step id, `duplicate_id` is reported on whichever of the two comes second in the walk, which visits a container's branch ids before its nested steps.
- Like `while`, the permission rule for an `http_fetch` in a branch cannot be reached through validation today, because branch steps must keep ids.

Tests: `tests/workflow.test.ts`; `fixtures/protocol/11-concurrent-llm.json`.

# composition-05: `switch` and shape merging

**Spec:** [composition](../../../specs/composition.md#switch) (`switch`, shape merging, message identity).

**To build:**
- **Shape merging**, used here and in composition-07: objects merge key by key; a key on one side only becomes `unknown`; differing kinds become `unknown`.
- **`switch`.**
  - `cases` (1–16) of `{ when, steps }`, plus optional `default`. First match wins. Unmatched messages go to `default`, or pass through when there is none.
  - Each case's steps run once on the batch routed to it.
  - Output order: input order when every branch preserves ids. Otherwise case order, then `default`, then unmatched.
  - Output shape is the merge of all branches.
- **`components.list`.** States the no-`default` pass-through in one sentence.
- **Spec update.** [pipeline-format](../../../specs/pipeline-format.md): `switch`.

**Blocked by:** [composition-03](completed/2026w45/composition-03-nested-steps-for-each.md).

**Verification:**
- **Routing and order:**
  - two id-preserving cases over 5 injected messages return them in input order, each with the field its case wrote;
  - `collect` in case 1 returns case 1's collected message first, then case 2's messages.
- **Unmatched and empty cases:**
  - an unmatched message without `default` passes through unchanged;
  - with `default`, it gets `default`'s write;
  - an empty `steps` passes matching messages through.
- **Shape merging:**
  - after a `switch` whose cases write different fields, a pointer to a field written by only one case validates and is checked at run time;
  - a pointer to a field both write validates statically.
- **Regression:** v0 example hashes are unchanged.

**Status:** done 2026-11-03

- [x] Shape merge helper with tests (`mergeShapes` in `src/pipeline/shape.ts`)
- [x] `switch` schema, routing, ordering rule
- [x] Tests (`tests/switch.test.ts`); pipeline-format updated

A case whose group is empty does not run its steps, so its nested steps report no invocation for that run.

# composition-03: nested steps and `for_each` (sequential)

**Spec:** [composition](../specs/composition.md#observable-behaviour) (nested steps, message identity, `for_each`, run report), [permissions](../specs/permissions.md) (derivation walk), [pipeline-format](../specs/pipeline-format.md).

**To build:** the container machinery every later ticket uses, proved with `for_each` at `concurrency: 1`.
- **Schema.** Step lists under named fields. A nested step has the same shape as a top-level processor.
- **Ceilings.** Nesting depth 4 (`nesting_too_deep`) and 64 steps in total (`too_many_steps`), reported by `components.list`.
- **Ids.** Step ids unique pipeline-wide (`duplicate_id`).
- **Validation recursion.** Shapes flow through nested steps, and ordering constraints apply inside.
- **Id preservation.** Each component declares whether it preserves ids, and containers derive it from their step lists. The property is computed here; its first error code comes in composition-08.
- **Permissions.** Derivation walks the whole tree. For `receives_fetched_content` it uses document order (the `while` and `workflow` parts come with those tickets).
- **Run report.** A nested step's entry gains `parent` and `invocations`, with counts summed over invocations.
- **`for_each`.**
  - Runs steps per message; `concurrency` accepted from 1 to 8, but this ticket always runs sequentially.
  - Output in input order. The first failure fails the run.
  - Validation warning `per_message_context` for `collect` directly inside it.
- **Spec update.** [pipeline-format](../specs/pipeline-format.md): nesting, step-id uniqueness, ceilings, the three new codes.

**Blocked by:** [composition-01](completed/2026w45/composition-01-condition-filter.md), for the shape-check helpers it extends.

**Verification:**
- **Behaviour:**
  - `for_each` around `template → host_llm` over 3 injected messages makes 3 sequential calls with v0-format keys and returns outputs in input order;
  - the report shows `classify` with `parent: "<for_each id>"` and `invocations: 3`;
  - a failure on message 2 fails the run with that step and message id.
- **Validation errors:**
  - a duplicate id between a nested and a top-level step gives `duplicate_id`;
  - depth 5 gives `nesting_too_deep`;
  - 65 steps give `too_many_steps`;
  - `collect` inside `for_each` validates with the `per_message_context` warning.
- **Permissions and regression:**
  - an `http_fetch` nested before a `host_llm` sets `receives_fetched_content`;
  - the v0 example's `permissions_hash` and `host.llm` keys are unchanged.

**Status:** open

- [ ] Schema and validation recursion, ceilings, `duplicate_id`
- [ ] Id-preservation property per component and container
- [ ] Permission walk; report `parent`/`invocations`
- [ ] `for_each` sequential; pipeline-format updated

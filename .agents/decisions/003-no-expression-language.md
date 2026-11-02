# ADR 003: No expression language in pipelines

Date: 2026-11-03. Status: accepted (Hong, grilling decision 5). Expect pressure to revisit; this record is the bar a proposal must clear.

## Context

Benthos has Bloblang; most stream processors grow a mapping language because real data needs reshaping. The brief's central claim is "a narrow language is safer than free code", and Wriven's sidecar grilling (decision 14) ruled that "không có component chạy mã nội tuyến". A mapping language is inline code: it loops, branches and computes, so it would need its own sandbox, its own tests and its own permission story, and the agent would write programs in it.

The v0 example (fetch three feeds, keep new entries, summarize once, deliver) needs: field access, text assembly, batch-to-one aggregation. None needs computation beyond lookup.

## Decision

- Field access is JSON Pointer (RFC 6901) into `data`, or `meta:<key>`. Nothing else.
- `template` supports `{{/pointer}}` and `{{meta:key}}` placeholders only: no filters, conditionals, loops or functions.
- Any need for computation becomes a component with a JSON Schema, declared output shape, declared permissions and tests. `collect` is the first example: "all items as one text" is a component, not a template loop.
- Conditional behaviour, where needed, is a declarative enum on a component (`on_error: skip`, `missed: run_once`, `min_items`), never a predicate expression.

## Consequences

- Pipelines are data with no evaluation semantics; validation is total and permissions derive mechanically.
- The component set will grow faster than it would with a language; every addition is reviewable and has a sentence.
- Some things will be awkward (filtering entries by keyword needs a `filter_contains` component rather than a one-liner). That awkwardness is the signal to add a component, and the cost is paid once per capability rather than once per pipeline.
- A future proposal for an expression language must show: a concrete task a schema-checked component cannot express reasonably; how the language is sandboxed and bounded; how its effects render as sentences; and why the agent writing programs in it is safer than the agent writing components' config.

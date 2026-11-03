# example-host-02: price table with its source, and Haiku's long-prompt price

**Spec:** [example-host](../../../specs/example-host.md) (decision 7).

**To build:**
- In `examples/host/provider.ts`, the price table's comment names https://platform.claude.com/docs/en/about-claude/pricing and the date it was read (2026-11-03), replacing the reference to the skill's cached table.
- `estimateCost` prices `claude-haiku-5-5` at $0.50 / $2.50 per million input / output tokens when the prompt is over 100 000 input tokens, and at $0.10 / $0.50 otherwise. Opus 5.5 ($4 / $20) and Sonnet 5.5 ($2 / $10) are unchanged.
- The example's README says where the prices come from and when they were read.

**Blocked by:** nothing.

**Verification:**
- Unit tests in `examples/host/host.test.ts`: Haiku 5.5 at 150 000 input and 1 000 output tokens costs 0.0775; at 50 000 and 1 000 it costs 0.0055; an unknown model returns no cost.
- `bun run test:example` and `bun run typecheck:example` pass.

**Status:** done 2026-11-03

- [x] Price table cites the pricing page and the date it was read; caching, batch and US-only prices named as not modelled
- [x] `longPrompt` price for Haiku 5.5 above 100 000 input tokens
- [x] Example README says where the prices come from

Cost tests in `examples/host/host.test.ts` ("cost estimates"); the Haiku case failed before the change. Ran: `bun run test:example` 10/10, `bun run typecheck:example`.

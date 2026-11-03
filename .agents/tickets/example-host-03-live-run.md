# example-host-03: one live run against Claude, recorded

**Spec:** [example-host](../specs/example-host.md) (decision 9).

**To build:** nothing new in code. Run the example against the real provider once and record it.
- `bun main.ts run pipelines/hello.json` in `examples/host`, answering "y" twice.
- `bun main.ts chat` with one request that ends in a created stream, approved and run once.
- In the example's README, "What was run": the date, machine and macOS version, Bun version, the model each reply reports, tokens and estimated cost from the run report, and anything that behaved differently from the offline run. Any fix this needs gets its own commit and a test that reproduces it with the scripted provider.

**Blocked by:** Hong providing credentials (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or an `ant auth login` profile) and agreeing to the spend, which is a few cents. Best after example-host-01 and -02, so the recorded output is the final one.

**Verification:** the README entry exists with the fields above, and `.data/reports/` holds the two reports it cites (not committed).

**Status:** open, blocked on credentials

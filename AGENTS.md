# Working in this repository

This file is for agents and people working on wriven-workflow. The decision maker is Hong. Nothing here is evidence that anything has been built: a specification describes intended behaviour, a ticket describes work, and a decision record describes a choice.

## Workflow

Product changes follow **inbox → grilling → spec → tickets → decisions**, the same shape as wriven-desktop:

1. **Inbox** (`.agents/inbox/YYYYWww/<slug>.md`): capture the intent in Hong's words. Grilling records, with numbered decisions and the date, live in the same file. This is the only part of the repository written in Vietnamese.
2. **Spec** (`.agents/specs/<slug>.md`): scope, observable behaviour, decisions with reasons, risks, acceptance criteria, open points. Specs inherit decisions from the inbox; they do not invent new ones. Add every spec to `.agents/specs/README.md`.
3. **Tickets** (`.agents/tickets/<feature>-<NN>-<slug>.md`): vertical slices in dependency order, each demonstrable on its own, each small enough for one fresh context window. Each ticket names what blocks it and how it is verified. Finished tickets move to `.agents/tickets/completed/YYYYwNN/`.
4. **Decisions** (`.agents/decisions/NNN-<slug>.md`): one record per choice with a large trade-off: context, options considered, decision, consequences. A decision record is updated by a new record that supersedes it, never rewritten in place.
5. **Open questions** (`.agents/open-questions.md`): what Hong must decide and what the host side must do. Keep it current; remove an item only when the answer is recorded somewhere linkable.

## Language

- Everything in the repository is English, except `.agents/inbox/`, which keeps Hong's intent and grilling records in Vietnamese.
- Every string the engine emits that a person may read (permission sentences, error messages, run report text) is English, quoted verbatim in specs and tickets.
- Identifiers in prose stay as code: `host_llm`, `stream.approve`.

## Principles

- **Agents write configuration, not code.** No component executes inline code, mappings or scripts. If a pipeline cannot express something, propose a schema-checked component; do not propose an expression language. [ADR 003](.agents/decisions/003-no-expression-language.md).
- **Hide the mechanism, never the consequences.** Anything that leaves the machine, costs money, runs on a schedule or keeps state must be derivable from the pipeline and renderable as an English sentence by code, not written by the model. [Permissions](.agents/specs/permissions.md).
- **The host is always the parent and always holds the keys.** The engine never reads a provider key from the environment, a file or the Keychain. Language model calls go back to the host. [Host protocol](.agents/specs/host-protocol.md).
- **No retry, no fallback by default.** Both are explicit, per component, and visible in permissions.
- **No subprocesses from pipelines.** There is no `command` or `subprocess` component, and the sandbox profile denies `process-exec`. This is a ban, not a permission.
- **Test without real services.** A fake host, a fake clock, injected input and recorded fixtures must be enough to run every test. A live check is a separate, named activity with its date recorded.
- **Record what you read and when.** Any claim about a runtime, a provider API or an operating system behaviour carries its source URL and the date it was read, or the words "not verified". Measurements say which machine and which versions.

## Coding principles (for when code exists)

- State assumptions. When unsure, ask Hong; when two readings are possible, present both.
- Smallest change that solves the problem. No speculative options, no abstraction for a single use.
- Change only what the task needs. Report dead code; do not delete it in passing.
- Turn work into verifiable criteria first, then make them pass. A failing test reproduces a bug before it is fixed.
- Before calling work done: format, lint, run the relevant tests, read the diff, and state what was not run.
- Dependencies: the engine ships as one binary, so every dependency is part of the supply chain the host inherits. Prefer the runtime's built-ins. A new npm dependency needs a line in the relevant spec saying why, and its license must be MIT-compatible.
- Never copy code from Redpanda Connect's enterprise connectors (Redpanda Community License). Copying from Apache-2.0 or MIT sources keeps their notices. Preferred: read, then write from scratch.

## Research notes

`.agents/research/` holds the notes behind the design, each dated. When a note is more than a few months old and a spec relies on it, re-read the source before building on it.

## Git

The repository has no remote yet. Commit directly to `main`. Commit messages say what changed and why, in English.

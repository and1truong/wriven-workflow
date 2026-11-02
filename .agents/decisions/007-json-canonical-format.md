# ADR 007: JSON is the canonical pipeline format; tool schemas use the provider-neutral subset

Date: 2026-11-03. Status: accepted (Hong, grilling decision 9).

## Context

The agent delivers a pipeline as the argument of a tool call. On Anthropic, Gemini and OpenRouter that argument is JSON (an object, an object, a JSON string respectively; [research](../research/research-tool-calling.md), read 2026-11-03). Benthos-family tools are YAML-first because humans write their configs. Here no human writes one. The three providers also accept different JSON Schema keywords for tool parameters; Gemini's `parameters` Schema has no `$ref`, `oneOf`, `allOf`, `additionalProperties` or `const`; Anthropic's strict mode requires `additionalProperties:false` and forbids numeric bounds; OpenRouter caps function names at 64 characters.

## Decision

- The pipeline document is JSON. RPC methods accept JSON only. The CLI (`validate`, `test`) also accepts YAML for people and converts it before validation.
- The engine publishes a full JSON Schema (with `oneOf` per component) for the pipeline format, used by validation and for humans. Tool `input_schema`s do **not** embed it; the `pipeline` argument is typed as a plain object with a description pointing at `workflow_list_components`, and validation errors carry paths.
- Every tool `input_schema` uses only: root object, `properties`, `required`, `type`, `description`, string `enum`, `items`, shallow nesting. Tool names match `^[a-zA-Z0-9_-]{1,64}$`.
- A repository test encodes each tool for all three providers and checks the subset.

## Consequences

- No YAML parser in the engine's trust boundary for agent input; one less place for ambiguity (YAML's implicit typing).
- The model learns the pipeline shape from `workflow_list_components` and from validation errors, not from a giant tool schema; this also keeps tool definitions small in tokens.
- Hosts encode tools mechanically per provider; nothing in the engine knows which provider is in use.
- If a provider later supports richer schemas, the subset can widen, but the lowest common denominator at that time rules.

# wriven-workflow

A small stream processor that an AI agent drives on behalf of a person, so that "every weekday at 8:00, summarize the new posts from these three feeds" becomes a pipeline that can be validated, tested with fake input, approved in plain English, run under an OS sandbox, paused, edited with a diff, and rolled back.

**Status: v0 built, not integrated.** The engine runs the feed example end to end against a fake host, under the sandbox and proxy, and passes its protocol conformance fixtures. No real host has spoken to it, and it has not fetched from the open web. Decisions are recorded under [`.agents/`](.agents/); the integration contract for a host application is [`.agents/specs/host-protocol.md`](.agents/specs/host-protocol.md), and [`docs/host-integration.md`](docs/host-integration.md) is how to meet it.

```bash
bun install
```

```bash
bun test
```

```bash
bun run build && dist/wriven-workflow doctor --self-test
```

```bash
dist/wriven-workflow test fixtures/pipelines/valid/feed-digest.json
```

```bash
dist/wriven-workflow fake-host --conformance fixtures/protocol
```

## What it is

- A **pipeline engine** written in TypeScript and shipped as one executable. A pipeline is data: a JSON document of `input → processors → output` plus mandatory limits. There is no scripting language inside a pipeline. When something cannot be expressed, the answer is a new, schema-checked component, not a new language.
- A **tool for agents, not for people.** The person says what they want in chat. The agent in the host application writes the pipeline, validates it, tests it, and submits it. The person never sees JSON or YAML; they see what the pipeline is allowed to do, in English sentences the engine derives from the configuration, and they approve or refuse that.
- A **child process of a host.** The host (first: [Wriven Desktop](https://github.com/and1truong/wriven-desktop), a native macOS chat app) starts the engine and talks JSON-RPC over stdio. The engine never holds a provider API key: a pipeline step that needs a language model calls back to the host, which calls the provider with its own code and keys, and reports usage back. Results go back to the host, which stores and shows them. The engine exits when its stdin closes.
- **Safe by construction, visibly.** Permissions are not declared by the agent; they are computed from the configuration (which hosts a pipeline fetches from, how many model calls per run, how often it runs) and pinned at approval. Any edit that widens them needs approval again. Each run executes in its own sandboxed process (macOS Seatbelt) that can write only its own state directory and can reach the network only through an allowlisting proxy owned by the engine. Nothing retries or falls back unless the pipeline says so, and then it shows in the permissions.

## Who it is for

- Host applications that want to give an agent a safe way to automate recurring work without letting it write and run arbitrary scripts.
- Right now, one host: Wriven Desktop. The repository is independent and MIT-licensed, but every v0 choice was made so that Wriven can integrate it. See [open questions](.agents/open-questions.md) for what Wriven must have in place first.

## What it is not

- Not a general-purpose integration platform with hundreds of connectors. v0 has eleven components, enough for the feed-digest example end to end.
- Not a scheduler daemon. When the host owns the clock, the engine runs when the host says so. Running while the host is closed (for example under `launchd`) is explicitly out of v0.
- Not a place where agents write code. Agents write configuration. Extensions are a curated set that ships with the engine; the agent mode cannot load modules.
- Not a replacement for the host's provider layer, and not a JavaScript runtime embedded in the host.
- Not a Benthos, Redpanda Connect or Bento fork. The design borrows their delivery model (one acknowledgement per batch, backpressure through bounded in-flight work, batching policy, unit tests with fake input) and nothing else. See [the research notes](.agents/research/research-benthos.md) for what was read, when, and under which licenses.

## Where things are

| Path | What |
| --- | --- |
| [`AGENTS.md`](AGENTS.md) | How to work in this repository: workflow, language, principles |
| [`src/`](src/) | The engine: `protocol`, `engine`, `pipeline`, `components`, `executor`, `supervisor`, `scheduler`, `state`, `harness`, `tools` |
| [`fixtures/`](fixtures/) | Pipelines, feeds, test certificates and [protocol conformance scenarios](fixtures/protocol/README.md) |
| [`docs/host-integration.md`](docs/host-integration.md) | How a host integrates the engine, with what Wriven has today and lacks |
| [`examples/host/`](examples/host/README.md) | A working example host in TypeScript: spawn, handshake, `host.llm` with Claude, approval cards, results, reports, and the agent tool loop |
| [`.agents/inbox/`](.agents/inbox/README.md) | The original intent and the grilling record, in Vietnamese |
| [`.agents/specs/`](.agents/specs/README.md) | Specifications: architecture, pipeline format, delivery semantics, permissions, host protocol, agent surface, scheduling, packaging, threat model |
| [`.agents/decisions/`](.agents/decisions/README.md) | Architecture decision records for the choices with large trade-offs |
| [`.agents/tickets/`](.agents/tickets/README.md) | Vertical slices in dependency order; finished ones under `completed/` |
| [`.agents/research/`](.agents/research/) | What was read on the web, with URLs and dates, and what was measured |
| [`.agents/open-questions.md`](.agents/open-questions.md) | What Hong still has to decide, and what the Wriven side must do before integration |

## License

MIT. See [LICENSE](LICENSE).

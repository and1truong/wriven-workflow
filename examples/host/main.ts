// Terminal front end for the example host.
//
//   bun main.ts run <pipeline.json> [--offline]   create, approve, run once, show the result
//   bun main.ts chat                              talk to a model that builds automations
//
// Options: --engine <path> (default: dist/wriven-workflow, else the engine from source),
// --data <dir> (default: examples/host/.data), --sandbox optional, --model <id>.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Agent, anthropicModelClient } from "./agent.ts";
import { type ApprovalCard, ExampleHost } from "./host.ts";
import { AnthropicProvider, type Provider, ScriptedProvider } from "./provider.ts";
import { EngineError } from "./rpc.ts";

const REPO = resolve(import.meta.dir, "../..");
const USAGE = "usage: bun main.ts run <pipeline.json> [--offline] | chat   [--engine <path>] [--data <dir>] [--sandbox optional] [--model <id>]";

interface Args {
  command?: string;
  file?: string;
  offline: boolean;
  engine?: string;
  data: string;
  sandbox: "required" | "optional";
  model?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { offline: false, data: join(import.meta.dir, ".data"), sandbox: "required" };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--offline") args.offline = true;
    else if (arg === "--engine") args.engine = argv[++i];
    else if (arg === "--data") args.data = resolve(argv[++i]!);
    else if (arg === "--sandbox") args.sandbox = argv[++i] === "optional" ? "optional" : "required";
    else if (arg === "--model") args.model = argv[++i];
    else positional.push(arg);
  }
  [args.command, args.file] = positional;
  return args;
}

export function engineCommand(explicit?: string): string[] {
  if (explicit) return [resolve(explicit)];
  const binary = join(REPO, "dist", "wriven-workflow");
  if (existsSync(binary)) return [binary];
  return [process.execPath, join(REPO, "src", "main.ts")];
}

const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
// One iterator for the whole session, so lines typed (or piped) ahead of a question are kept.
const lines = terminal[Symbol.asyncIterator]();

// Asynchronous on purpose: while the person thinks, the host keeps reading the engine.
async function readLine(prompt: string): Promise<string | null> {
  process.stdout.write(prompt);
  const next = await lines.next();
  if (next.done) return null;
  if (!process.stdin.isTTY) process.stdout.write(`${next.value}\n`);
  return next.value;
}

async function ask(question: string): Promise<boolean> {
  return /^y(es)?$/i.test((await readLine(question))?.trim() ?? "");
}

function showCard(card: ApprovalCard): void {
  console.log(`\n┌ Approve "${card.name}"?`);
  if (card.diff) {
    for (const line of card.diff.added) console.log(`│ + ${line}`);
    for (const line of card.diff.removed) console.log(`│ - ${line}`);
  } else {
    for (const sentence of card.rendered) console.log(`│ ${sentence}`);
  }
  console.log("└");
}

// Shows each waiting card and asks. Returns what happened, for the model's next turn.
async function settleApprovals(host: ExampleHost, streamIds: Iterable<string>): Promise<string[]> {
  const notes: string[] = [];
  for (const streamId of [...new Set(streamIds)]) {
    const card = await host.approvalCard(streamId);
    if (!card) continue;
    showCard(card);
    if (await ask("Approve? [y/N] ")) {
      await host.approve(card);
      notes.push(`The person approved "${card.name}" (${streamId}).`);
      if (await ask("Run it now? [y/N] ")) {
        const report = await host.runNow(streamId);
        printRun(host, report);
        notes.push(`It ran once: ${report.status}.`);
      }
    } else {
      await host.decline(card);
      notes.push(`The person declined "${card.name}"; the stream was deleted.`);
    }
  }
  return notes;
}

function printRun(host: ExampleHost, report: any): void {
  console.log(`\nRun ${report.run_id}: ${report.status}${report.error ? ` (${report.error.kind}: ${report.error.message})` : ""}`);
  const llm = report.llm;
  if (llm) {
    const cost = typeof llm.cost_usd === "number" ? `, about $${llm.cost_usd.toFixed(4)}` : "";
    console.log(`Model calls: ${llm.calls}, tokens in ${llm.input_tokens} / out ${llm.output_tokens}${cost}.`);
  }
  for (const result of host.results.filter((r) => r.run_id === report.run_id)) {
    console.log(`\n## ${result.title}\n\n${result.body}\n\n(saved to ${result.path})`);
  }
}

function provider(args: Args): Provider {
  return args.offline ? new ScriptedProvider() : new AnthropicProvider(args.model ? { model: args.model } : {});
}

async function runFile(host: ExampleHost, file: string): Promise<number> {
  const pipeline = JSON.parse(readFileSync(file, "utf8"));
  const validation = await host.call("pipeline.validate", { pipeline });
  if (!validation.valid) {
    for (const error of validation.errors) console.error(`${error.path ?? ""}: ${error.message}`);
    return 1;
  }
  const created = await host.call("stream.create", { pipeline });
  await settleApprovals(host, [created.stream_id]);
  return 0;
}

async function chat(host: ExampleHost, args: Args): Promise<number> {
  const agent = new Agent(host, anthropicModelClient(), {
    ...(args.model ? { model: args.model } : {}),
    onToolCall: (name, _input, isError) => console.log(`  · ${name}${isError ? " (error)" : ""}`),
  });
  console.log("Describe what you want automated. /quit to leave.");
  let notes: string[] = [];
  for (;;) {
    const line = await readLine("\nyou> ");
    if (line === null || line.trim() === "/quit") return 0;
    const text = line.trim();
    if (!text) continue;
    const turn = await agent.send(text, notes.length ? notes.join("\n") : undefined);
    console.log(`\nassistant> ${turn.text}`);
    notes = await settleApprovals(host, [...turn.awaitingApproval, ...host.needsApproval]);
  }
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.command !== "run" && args.command !== "chat") {
    console.error(USAGE);
    return 2;
  }
  if (args.command === "run" && !args.file) {
    console.error(USAGE);
    return 2;
  }
  if (args.command === "chat" && args.offline) {
    console.error("chat needs a model; --offline only works with run.");
    return 2;
  }
  const host = await ExampleHost.start({
    engine: engineCommand(args.engine),
    dataDir: args.data,
    provider: provider(args),
    sandbox: args.sandbox,
    log: process.env.EXAMPLE_HOST_DEBUG ? (line) => console.error(line) : undefined,
  });
  try {
    return args.command === "run" ? await runFile(host, args.file!) : await chat(host, args);
  } catch (err) {
    console.error(err instanceof EngineError ? `${err.kind}: ${err.message}` : (err as Error).message);
    return 1;
  } finally {
    terminal.close();
    await host.stop();
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));

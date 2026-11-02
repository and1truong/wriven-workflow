// Replays fixtures/protocol/*.json against an engine. A fixture is a list of steps: lines the host
// sends, patterns it must see, and checks on what the fake host recorded. Format documented in
// fixtures/protocol/README.md.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selfCommand } from "../self.ts";
import { FakeHost, type LlmScript, type ResultScript } from "./fake-host.ts";

interface Step {
  engine?: string;
  start_engine?: string;
  send?: any;
  expect?: any;
  capture?: Record<string, string>;
  within_ms?: number;
  expect_absent?: any;
  close_stdin?: boolean;
  expect_exit?: number;
  assert_fake_host?: { provider_calls?: number; results?: number };
  sleep_ms?: number;
}

interface Fixture {
  name: string;
  description: string;
  env?: Record<string, string>;
  fake_host?: { llm?: LlmScript; result?: ResultScript };
  steps: Step[];
}

export interface ScenarioResult {
  file: string;
  name: string;
  passed: boolean;
  error?: string;
  duration_ms: number;
}

const DEFAULT_WAIT_MS = 20_000;

export async function runConformance(dir: string, command = selfCommand(), print = false): Promise<ScenarioResult[]> {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const results: ScenarioResult[] = [];
  for (const file of files) {
    const fixture = JSON.parse(readFileSync(join(dir, file), "utf8")) as Fixture;
    const started = Date.now();
    try {
      await runFixture(fixture, command, print);
      results.push({ file, name: fixture.name, passed: true, duration_ms: Date.now() - started });
    } catch (err) {
      results.push({ file, name: fixture.name, passed: false, error: (err as Error).message, duration_ms: Date.now() - started });
    }
  }
  return results;
}

async function runFixture(fixture: Fixture, command: string[], print: boolean): Promise<void> {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "wriven-workflow-conformance-")));
  const engines = new Map<string, FakeHost>();
  const vars: Record<string, unknown> = { state_dir: stateDir };
  const consumed = new Map<FakeHost, Set<number>>();
  const start = (name: string) => {
    const env = fixture.env ? { ...(process.env as Record<string, string>), ...fixture.env } : undefined;
    const host = new FakeHost({ command, env, llm: fixture.fake_host?.llm, result: fixture.fake_host?.result, print, label: engines.size > 0 || name !== "main" ? name : undefined });
    engines.set(name, host);
    consumed.set(host, new Set());
    return host;
  };
  try {
    start("main");
    for (const [index, step] of fixture.steps.entries()) {
      const where = `step ${index + 1}`;
      if (step.start_engine) {
        start(step.start_engine);
        continue;
      }
      const host = engines.get(step.engine ?? "main");
      if (!host) throw new Error(`${where}: no engine named ${step.engine}`);
      if (step.send !== undefined) {
        host.send(substitute(step.send, vars));
      } else if (step.expect !== undefined) {
        const pattern = substitute(step.expect, vars);
        const seen = consumed.get(host)!;
        const message = await host.waitFor(
          (m) => !seen.has(host.received.indexOf(m)) && matches(pattern, m) === null,
          step.within_ms ?? DEFAULT_WAIT_MS,
          `${where}: ${JSON.stringify(pattern)}`,
        );
        seen.add(host.received.indexOf(message));
        for (const [name, pointer] of Object.entries(step.capture ?? {})) vars[name] = pointerGet(message, pointer);
      } else if (step.expect_absent !== undefined) {
        const pattern = substitute(step.expect_absent, vars);
        const hit = host.received.find((m) => matches(pattern, m) === null);
        if (hit) throw new Error(`${where}: expected no ${JSON.stringify(pattern)}, saw ${JSON.stringify(hit)}`);
      } else if (step.close_stdin) {
        host.closeStdin();
      } else if (step.expect_exit !== undefined) {
        const code = await Promise.race([host.exited, Bun.sleep(step.within_ms ?? DEFAULT_WAIT_MS).then(() => "timeout" as const)]);
        if (code !== step.expect_exit) throw new Error(`${where}: expected exit ${step.expect_exit}, got ${code}`);
      } else if (step.assert_fake_host) {
        const { provider_calls, results } = step.assert_fake_host;
        if (provider_calls !== undefined && host.providerCalls.length !== provider_calls) {
          throw new Error(`${where}: expected ${provider_calls} provider calls, saw ${host.providerCalls.length}`);
        }
        if (results !== undefined && host.results.length !== results) {
          throw new Error(`${where}: expected ${results} results, saw ${host.results.length}`);
        }
      } else if (step.sleep_ms !== undefined) {
        await Bun.sleep(step.sleep_ms);
      } else {
        throw new Error(`${where}: unknown step ${JSON.stringify(step)}`);
      }
    }
  } finally {
    for (const host of engines.values()) {
      host.closeStdin();
      await Promise.race([host.exited, Bun.sleep(12_000)]);
      if (host.exitCode === null) host.kill();
    }
    rmSync(stateDir, { recursive: true, force: true });
  }
}

// "$name" is replaced by a captured value, inside strings too.
function substitute(value: any, vars: Record<string, unknown>): any {
  if (typeof value === "string") {
    const whole = /^\$([a-z_]+)$/.exec(value);
    if (whole && whole[1]! in vars) return vars[whole[1]!];
    return value.replace(/\$([a-z_]+)/g, (all, name) => (name in vars ? String(vars[name]) : all));
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)]));
  }
  return value;
}

// Null when `actual` satisfies `pattern`, else why not. Objects match by subset; arrays match
// element by element, and a trailing "<...>" allows more. Placeholders: <any>, <string>, <number>, <time>.
export function matches(pattern: any, actual: any, path = ""): string | null {
  if (pattern === "<any>") return actual === undefined ? `${path} is missing` : null;
  if (pattern === "<string>") return typeof actual === "string" ? null : `${path} is not a string`;
  if (pattern === "<number>") return typeof actual === "number" ? null : `${path} is not a number`;
  if (pattern === "<time>") return typeof actual === "string" && !Number.isNaN(Date.parse(actual)) ? null : `${path} is not a time`;
  if (Array.isArray(pattern)) {
    if (!Array.isArray(actual)) return `${path} is not an array`;
    const open = pattern[pattern.length - 1] === "<...>";
    const items = open ? pattern.slice(0, -1) : pattern;
    if (open ? actual.length < items.length : actual.length !== items.length) return `${path} has length ${actual.length}`;
    for (let i = 0; i < items.length; i++) {
      const why = matches(items[i], actual[i], `${path}/${i}`);
      if (why) return why;
    }
    return null;
  }
  if (pattern && typeof pattern === "object") {
    if (!actual || typeof actual !== "object") return `${path} is not an object`;
    for (const [key, value] of Object.entries(pattern)) {
      const why = matches(value, actual[key], `${path}/${key}`);
      if (why) return why;
    }
    return null;
  }
  return pattern === actual ? null : `${path} is ${JSON.stringify(actual)}, expected ${JSON.stringify(pattern)}`;
}

function pointerGet(value: any, pointer: string): unknown {
  let current = value;
  for (const part of pointer.split("/").slice(1)) current = current?.[part];
  return current;
}

export function makeTempStateDir(prefix = "wriven-workflow-"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

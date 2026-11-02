// A host that speaks the public protocol: spawns an engine, keeps a record of every line, and answers
// `host.llm` and `host.result` from a script. Used by `fake-host`, the conformance runner and tests.

import { LineSplitter } from "../protocol/lines.ts";
import { ERROR_CODES } from "../protocol/errors.ts";

export interface LlmScript {
  // "echo" answers with the prompt, "hold" never answers until $/cancel.
  mode?: "echo" | "hold";
  responses?: string[];
  error?: { kind: keyof typeof ERROR_CODES; message: string; [key: string]: unknown };
  cost_usd?: number;
  // Stores the reply and drops the response this many times, as a lost line would.
  drop_responses?: number;
}

export interface ResultScript {
  // Fails this many writes with host_error before accepting.
  fail_first?: number;
}

export interface FakeHostOptions {
  command: string[];
  env?: Record<string, string>;
  cwd?: string;
  llm?: LlmScript;
  result?: ResultScript;
  print?: boolean;
  label?: string;
}

export function selfCommand(): string[] {
  if (import.meta.path.startsWith("/$bunfs/")) return [process.execPath];
  return [process.execPath, new URL("../main.ts", import.meta.url).pathname];
}

export class FakeHost {
  readonly received: any[] = [];
  readonly sent: any[] = [];
  readonly stderr: string[] = [];
  readonly providerCalls: any[] = [];
  readonly results: any[] = [];
  readonly pid: number;
  readonly exited: Promise<number>;

  private readonly process: Bun.PipedSubprocess;
  private readonly llmStore = new Map<string, any>();
  private readonly storedResults = new Map<string, any>();
  private readonly held = new Map<string, any>();
  private nextId = 1;
  private llmIndex = 0;
  private dropsLeft: number;
  private resultFailuresLeft: number;
  private waiters: Array<() => void> = [];
  private stdinClosed = false;
  exitCode: number | null = null;

  constructor(private readonly options: FakeHostOptions) {
    this.dropsLeft = options.llm?.drop_responses ?? 0;
    this.resultFailuresLeft = options.result?.fail_first ?? 0;
    this.process = Bun.spawn([...options.command, "serve"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: options.cwd,
      env: options.env ?? (process.env as Record<string, string>),
    }) as Bun.PipedSubprocess;
    this.pid = this.process.pid;
    this.exited = this.process.exited.then((code) => {
      this.exitCode = code;
      this.wake();
      return code;
    });
    void this.pump(this.process.stdout as ReadableStream<Uint8Array>, (line) => this.onEngineLine(line));
    void this.pump(this.process.stderr as ReadableStream<Uint8Array>, (line) => {
      this.stderr.push(line);
      this.print("stderr", line);
    });
  }

  setLlm(script: LlmScript): void {
    this.options.llm = script;
    this.dropsLeft = script.drop_responses ?? 0;
    this.llmIndex = 0;
  }

  send(message: unknown): void {
    this.sent.push(message);
    this.sendRaw(JSON.stringify(message));
  }

  sendRaw(line: string): void {
    this.print("host->engine", line.length > 2000 ? `${line.slice(0, 2000)}…` : line);
    void this.process.stdin.write(`${line}\n`);
    void this.process.stdin.flush();
  }

  // Sends a request and resolves with the whole response message.
  async request(method: string, params: unknown = {}, timeoutMs = 20_000): Promise<any> {
    const id = `h-${this.nextId++}`;
    this.send({ jsonrpc: "2.0", id, method, params });
    return this.waitFor((m) => m.id === id && !m.method, timeoutMs, `response to ${method}`);
  }

  // Sends a request and returns its result, or throws the error object.
  async call(method: string, params: unknown = {}, timeoutMs = 20_000): Promise<any> {
    const response = await this.request(method, params, timeoutMs);
    if (response.error) throw Object.assign(new Error(response.error.message), { rpc: response.error });
    return response.result;
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  // First received message matching, looking at everything seen so far and then at new arrivals.
  async waitFor(match: (message: any) => boolean, timeoutMs = 20_000, what = "message", from = 0): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (let i = from; i < this.received.length; i++) {
        if (match(this.received[i])) return this.received[i];
      }
      const left = deadline - Date.now();
      if (left <= 0 || this.exitCode !== null) {
        if (this.exitCode !== null) await Bun.sleep(20);
        for (let i = from; i < this.received.length; i++) {
          if (match(this.received[i])) return this.received[i];
        }
        throw new Error(`Timed out waiting for ${what}; received ${JSON.stringify(this.received).slice(-1500)}; stderr ${this.stderr.join("\n").slice(-500)}`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  notifications(method: string): any[] {
    return this.received.filter((m) => m.method === method && m.id === undefined);
  }

  closeStdin(): void {
    if (this.stdinClosed) return;
    this.stdinClosed = true;
    this.print("host->engine", "<stdin closed>");
    void this.process.stdin.end();
  }

  kill(): void {
    this.process.kill("SIGKILL");
  }

  private async pump(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
    const splitter = new LineSplitter({ onLine, onOversize: () => onLine('{"oversize":true}') }, 64 * 1024 * 1024);
    for await (const chunk of stream) splitter.push(chunk);
  }

  private onEngineLine(line: string): void {
    this.print("engine->host", line.length > 2000 ? `${line.slice(0, 2000)}…` : line);
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      message = { unparseable: line };
    }
    this.received.push(message);
    if (message.method === "host.llm" && message.id !== undefined) this.answerLlm(message);
    else if (message.method === "host.result" && message.id !== undefined) this.answerResult(message);
    else if (message.method === "$/cancel") this.answerCancel(message.params?.id);
    this.wake();
  }

  private answerLlm(request: any): void {
    const script = this.options.llm ?? { mode: "echo" };
    const key = request.params.idempotency_key;
    let reply = this.llmStore.get(key);
    if (!reply) {
      this.providerCalls.push(request.params);
      if (script.mode === "hold") {
        this.held.set(request.id, request);
        return;
      }
      if (script.error) {
        const { kind, message, ...extras } = script.error;
        this.respondError(request.id, kind, message, extras);
        return;
      }
      const prompt = request.params.messages?.[0]?.content ?? "";
      const text = script.responses
        ? (script.responses[Math.min(this.llmIndex++, script.responses.length - 1)] ?? "")
        : `[echo] ${prompt}`;
      reply = {
        text,
        usage: { input_tokens: prompt.length, output_tokens: text.length, ...(script.cost_usd !== undefined ? { cost_usd: script.cost_usd } : {}) },
        provider: "fake",
        model: "fake-1",
        finished: "stop",
      };
      this.llmStore.set(key, reply);
    }
    if (this.dropsLeft > 0) {
      this.dropsLeft--;
      this.print("host->engine", `<dropped response to ${request.id}>`);
      return;
    }
    this.send({ jsonrpc: "2.0", id: request.id, result: reply });
  }

  private answerResult(request: any): void {
    const key = request.params.idempotency_key;
    let stored = this.storedResults.get(key);
    if (!stored) {
      if (this.resultFailuresLeft > 0) {
        this.resultFailuresLeft--;
        this.respondError(request.id, "host_error", "The host could not write the result.", { reason: "busy" });
        return;
      }
      stored = { accepted: true, ref: `thread:${this.results.length + 1}` };
      this.storedResults.set(key, stored);
      this.results.push(request.params);
    }
    this.send({ jsonrpc: "2.0", id: request.id, result: stored });
  }

  private answerCancel(id: string): void {
    if (!this.held.has(id)) return;
    this.held.delete(id);
    this.respondError(id, "cancelled", "The host stopped the request.", { reason: "cancelled" });
  }

  private respondError(id: string, kind: keyof typeof ERROR_CODES, message: string, extras: Record<string, unknown> = {}): void {
    this.send({ jsonrpc: "2.0", id, error: { code: ERROR_CODES[kind], message, data: { kind, ...extras } } });
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  private print(direction: string, line: string): void {
    if (!this.options.print) return;
    const label = this.options.label ? `${this.options.label} ` : "";
    console.log(`${label}${direction} ${line}`);
  }
}

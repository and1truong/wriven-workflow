// The engine end of a host: spawn `wriven-workflow serve`, speak NDJSON JSON-RPC 2.0 over its
// stdin/stdout, and never block reading on anything. Contract: .agents/specs/host-protocol.md.

// The error kinds a host sends back to the engine, with their JSON-RPC codes. A test checks this
// table against the engine's own (src/protocol/errors.ts), so a host written from this file
// cannot drift from the protocol.
export const HOST_ERROR_CODES = {
  invalid_params: -32602,
  method_not_found: -32601,
  budget_exceeded: -32010,
  cancelled: -32013,
  credentials_missing: -32020,
  credentials_rejected: -32021,
  quota_exhausted: -32022,
  rate_limited: -32023,
  provider_unavailable: -32024,
  provider_refused: -32025,
  host_error: -32030,
} as const;

export type HostErrorKind = keyof typeof HOST_ERROR_CODES;

// An error this host answers a request with. `extras` go into `data` next to `kind`.
export class HostError extends Error {
  constructor(
    readonly kind: HostErrorKind,
    message: string,
    readonly extras: Record<string, unknown> = {},
  ) {
    super(message);
  }

  toObject() {
    return { code: HOST_ERROR_CODES[this.kind], message: this.message, data: { ...this.extras, kind: this.kind } };
  }
}

// An error the engine answered one of our requests with. `data.kind` is the contract.
export class EngineError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data: { kind: string; [key: string]: unknown },
  ) {
    super(message);
  }

  get kind(): string {
    return this.data?.kind ?? "unknown";
  }
}

export interface EngineHandlers {
  // A request from the engine (`host.llm`, `host.result`). Resolve with the result or throw a HostError.
  onRequest(method: string, params: any, id: string | number): Promise<unknown>;
  // A notification from the engine (`run.started`, `run.finished`, `stream.changed`, `log`, `$/cancel`).
  onNotification(method: string, params: any): void;
  // A line on the engine's stderr: one JSON log record.
  onStderr?(line: string): void;
}

// Lines may be up to 4 MiB on the wire; allow more so an oversize line is reported, not split.
const MAX_LINE_BYTES = 8 * 1024 * 1024;

export class EngineConnection {
  readonly exited: Promise<number>;
  private readonly child: Bun.PipedSubprocess;
  private readonly pending = new Map<string, { resolve(v: any): void; reject(e: Error): void }>();
  private nextId = 1;
  private stdinClosed = false;

  constructor(command: string[], private readonly handlers: EngineHandlers) {
    this.child = Bun.spawn([...command, "serve"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // The engine finds sandbox-exec through PATH; keep /usr/bin on it.
      env: { ...process.env, PATH: `/usr/bin:/bin:${process.env.PATH ?? ""}` },
    }) as Bun.PipedSubprocess;
    // Reading runs on its own task for the whole life of the engine. Responses to our requests
    // and requests from the engine arrive interleaved and out of order.
    void readLines(this.child.stdout as ReadableStream<Uint8Array>, (line) => this.onLine(line));
    void readLines(this.child.stderr as ReadableStream<Uint8Array>, (line) => this.handlers.onStderr?.(line));
    this.exited = this.child.exited.then((code) => {
      for (const { reject } of this.pending.values()) reject(new Error(`The engine exited with code ${code}.`));
      this.pending.clear();
      return code;
    });
  }

  // Sends a request and resolves with its result, or rejects with an EngineError.
  request<T = any>(method: string, params: unknown = {}): Promise<T> {
    const id = `host-${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  // Ends the engine cleanly: `shutdown` waits for a running run to drain, then the engine exits 0.
  async shutdown(): Promise<number> {
    try {
      await this.request("shutdown", {});
    } catch {
      // Already gone; closing stdin below is enough.
    }
    this.closeStdin();
    return this.exited;
  }

  closeStdin(): void {
    if (this.stdinClosed) return;
    this.stdinClosed = true;
    void this.child.stdin.end();
  }

  private write(message: unknown): void {
    if (this.stdinClosed) return;
    void this.child.stdin.write(`${JSON.stringify(message)}\n`);
    void this.child.stdin.flush();
  }

  private onLine(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      this.handlers.onStderr?.(JSON.stringify({ level: "error", msg: "unparseable line from the engine", line: line.slice(0, 200) }));
      return;
    }
    if (message.method === undefined) {
      // A response to one of our requests.
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new EngineError(message.error.code, message.error.message, message.error.data ?? { kind: "unknown" }));
      else waiter.resolve(message.result);
      return;
    }
    if (message.id === undefined) {
      this.handlers.onNotification(message.method, message.params ?? {});
      return;
    }
    // A request from the engine. Answer it whenever it settles, without holding up the reader:
    // host.llm takes as long as the provider does.
    void this.answer(message.id, message.method, message.params ?? {});
  }

  private async answer(id: string | number, method: string, params: any): Promise<void> {
    try {
      const result = await this.handlers.onRequest(method, params, id);
      this.write({ jsonrpc: "2.0", id, result });
    } catch (err) {
      const error = err instanceof HostError ? err : new HostError("host_error", `The host failed: ${(err as Error).message}`, { reason: "unexpected" });
      this.write({ jsonrpc: "2.0", id, error: error.toObject() });
    }
  }
}

async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) onLine(line);
    }
    if (buffer.length > MAX_LINE_BYTES) buffer = "";
  }
  if (buffer.trim()) onLine(buffer);
}

// One end of a newline-delimited JSON-RPC 2.0 connection. Knows framing and correlation only.

import { RpcError, toRpcError, type RpcErrorObject } from "./errors.ts";
import { MAX_LINE_BYTES } from "./lines.ts";

export interface RequestContext {
  id: string | number;
  signal: AbortSignal;
}

export interface PeerOptions {
  write(line: string): void;
  idPrefix: string;
  onRequest(method: string, params: any, ctx: RequestContext): Promise<unknown> | unknown;
  onNotification?(method: string, params: any): void;
  onLine?(direction: "in" | "out", line: string): void;
  maxLineBytes?: number;
}

export interface PendingRequest<T = any> {
  id: string;
  promise: Promise<T>;
}

export class Peer {
  private nextId = 1;
  private readonly pending = new Map<string, { resolve(value: any): void; reject(err: RpcError): void }>();
  private readonly incoming = new Map<string | number, AbortController>();
  private closed: RpcError | null = null;

  constructor(private readonly options: PeerOptions) {}

  receive(line: string): void {
    this.options.onLine?.("in", line);
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      this.sendError(null, new RpcError("parse_error", "The line is not valid JSON."));
      return;
    }
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      this.sendError(null, new RpcError("invalid_request", "A message must be a JSON object."));
      return;
    }
    if (typeof message.method === "string") {
      if (message.id === undefined) this.receiveNotification(message.method, message.params);
      else this.receiveRequest(message.id, message.method, message.params);
      return;
    }
    if (typeof message.id === "string" && this.pending.has(message.id)) {
      const waiter = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      if (message.error !== undefined) waiter.reject(RpcError.fromObject(message.error as RpcErrorObject));
      else waiter.resolve(message.result);
      return;
    }
    // A response to a request nobody is waiting for: late answer after a timeout or a cancel.
    if (message.id !== undefined && ("result" in message || "error" in message)) return;
    this.sendError(message.id ?? null, new RpcError("invalid_request", "A request must have a string method."));
  }

  reportOversize(): void {
    this.sendError(null, new RpcError("invalid_request", `A message is limited to ${MAX_LINE_BYTES} bytes.`));
  }

  request<T = any>(method: string, params: unknown): PendingRequest<T> {
    const id = `${this.options.idPrefix}${this.nextId++}`;
    if (this.closed) return { id, promise: Promise.reject(this.closed) };
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    if (!this.send({ jsonrpc: "2.0", id, method, params })) {
      const waiter = this.pending.get(id)!;
      this.pending.delete(id);
      waiter.reject(new RpcError("invalid_request", `The ${method} request is larger than the protocol's line limit.`, { reason: "message_too_large" }));
    }
    return { id, promise };
  }

  // Stops waiting for a request; a late response is ignored.
  abandon(id: string, err: RpcError): void {
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    waiter.reject(err);
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  // Fails everything outstanding and every later request: the other side can no longer answer.
  close(err: RpcError): void {
    this.closed = err;
    for (const waiter of this.pending.values()) waiter.reject(err);
    this.pending.clear();
  }

  private receiveNotification(method: string, params: any): void {
    if (method === "$/cancel") {
      this.incoming.get(params?.id)?.abort();
      return;
    }
    this.options.onNotification?.(method, params);
  }

  private receiveRequest(id: unknown, method: string, params: any): void {
    if (typeof id !== "string" && typeof id !== "number") {
      this.sendError(null, new RpcError("invalid_request", "A request id must be a string or an integer."));
      return;
    }
    const controller = new AbortController();
    this.incoming.set(id, controller);
    void (async () => {
      try {
        const result = await this.options.onRequest(method, params ?? {}, { id, signal: controller.signal });
        if (!this.send({ jsonrpc: "2.0", id, result: result ?? {} })) {
          this.sendError(id, new RpcError("invalid_request", `The ${method} result is larger than the protocol's line limit.`, { reason: "message_too_large" }));
        }
      } catch (err) {
        this.sendError(id, toRpcError(err));
      } finally {
        this.incoming.delete(id);
      }
    })();
  }

  private sendError(id: string | number | null, err: RpcError): void {
    this.send({ jsonrpc: "2.0", id, error: err.toObject() });
  }

  private send(message: unknown): boolean {
    const line = JSON.stringify(message);
    const limit = this.options.maxLineBytes ?? MAX_LINE_BYTES;
    if (line.length > limit / 4 && Buffer.byteLength(line) > limit) return false;
    this.options.onLine?.("out", line);
    this.options.write(`${line}\n`);
    return true;
  }
}

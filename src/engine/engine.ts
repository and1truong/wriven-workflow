// The `serve` process: handshake, method table and lifecycle. Business logic lives in the modules it
// calls; this file decides what is allowed when.

import { mkdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { RpcError } from "../protocol/errors.ts";
import { Peer, type RequestContext } from "../protocol/peer.ts";
import { logLine, type LogLevel } from "../log.ts";
import { ENGINE_NAME, ENGINE_VERSION, PIPELINE_FORMATS, PROTOCOL_VERSIONS, REPORT_VERSION } from "../version.ts";
import { tryLock } from "./lock.ts";

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export interface EngineOptions {
  write(line: string): void;
  exit(code: number): void;
  onLine?(direction: "in" | "out", line: string): void;
}

export class Engine {
  readonly peer: Peer;
  private initialized = false;
  private releaseLock: (() => void) | null = null;
  private stopping: Promise<void> | null = null;

  constructor(private readonly options: EngineOptions) {
    this.peer = new Peer({
      write: options.write,
      idPrefix: "e-",
      onLine: options.onLine,
      onRequest: (method, params, ctx) => this.dispatch(method, params, ctx),
    });
  }

  log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
    logLine(level, msg, fields);
    if (this.initialized) this.peer.notify("log", { level, msg, ...fields });
  }

  // The host closed our stdin: same as `shutdown` with the default timeout, but nobody is left to
  // answer, so requests to the host fail at once rather than wait out the timeout.
  async onStdinClosed(): Promise<void> {
    this.peer.close(new RpcError("cancelled", "The host closed the connection.", { reason: "host_gone" }));
    await this.stop(DEFAULT_SHUTDOWN_TIMEOUT_MS);
    this.options.exit(0);
  }

  private async dispatch(method: string, params: any, _ctx: RequestContext): Promise<unknown> {
    if (method === "initialize") return this.initialize(params);
    if (!this.initialized) {
      throw new RpcError("not_initialized", `The engine must be initialized before ${method}.`);
    }
    switch (method) {
      case "components.list":
        return { components: [], pipeline_schema: {} };
      case "shutdown":
        return this.shutdown(params);
      default:
        throw new RpcError("method_not_found", `There is no method named ${method}.`);
    }
  }

  private initialize(params: any): unknown {
    if (params?.protocol_version === undefined || !PROTOCOL_VERSIONS.includes(params.protocol_version)) {
      throw new RpcError("unsupported_version", `This engine speaks protocol versions ${PROTOCOL_VERSIONS.join(", ")}.`, {
        supported: PROTOCOL_VERSIONS,
      });
    }
    if (this.initialized) {
      throw new RpcError("conflict", "The engine is already initialized.", { reason: "already_initialized" });
    }
    const stateDir = checkStateDir(params.state_dir);
    const release = tryLock(join(stateDir, "engine.lock"));
    if (!release) {
      throw new RpcError("conflict", "Another engine holds the lock on this state directory.", { reason: "engine_lock_held" });
    }
    this.releaseLock = release;
    mkdirSync(join(stateDir, "streams"), { recursive: true, mode: 0o700 });
    this.initialized = true;
    return {
      protocol_version: params.protocol_version,
      engine: { name: ENGINE_NAME, version: ENGINE_VERSION },
      pipeline_formats: PIPELINE_FORMATS,
      report_version: REPORT_VERSION,
      sandbox: { available: false, mechanism: "none" },
      ceilings: {},
      components: [],
      tools: [],
      streams: [],
    };
  }

  private async shutdown(params: any): Promise<unknown> {
    await this.stop(DEFAULT_SHUTDOWN_TIMEOUT_MS, params?.timeout);
    setTimeout(() => this.options.exit(0), 0);
    return {};
  }

  private stop(defaultTimeoutMs: number, _timeout?: unknown): Promise<void> {
    this.stopping ??= (async () => {
      void defaultTimeoutMs;
      this.releaseLock?.();
      this.releaseLock = null;
    })();
    return this.stopping;
  }
}

function checkStateDir(stateDir: unknown): string {
  const refuse = (reason: string, message: string) => new RpcError("invalid_state_dir", message, { reason });
  if (typeof stateDir !== "string" || stateDir === "") throw refuse("missing", "state_dir is required.");
  let stat;
  try {
    stat = statSync(stateDir);
  } catch {
    throw refuse("missing", `The state directory ${stateDir} does not exist.`);
  }
  if (!stat.isDirectory()) throw refuse("not_a_directory", `${stateDir} is not a directory.`);
  if (stat.uid !== process.getuid!()) throw refuse("wrong_owner", `${stateDir} is not owned by the current user.`);
  if ((stat.mode & 0o777) !== 0o700) {
    throw refuse("wrong_mode", `${stateDir} must have mode 0700; it has ${(stat.mode & 0o777).toString(8).padStart(4, "0")}.`);
  }
  return realpathSync(stateDir);
}

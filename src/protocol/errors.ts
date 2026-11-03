// The typed error vocabulary of .agents/specs/host-protocol.md. `kind` is the contract; `code`
// exists for JSON-RPC conformance.

export const ERROR_CODES = {
  parse_error: -32700,
  invalid_request: -32600,
  method_not_found: -32601,
  invalid_params: -32602,
  not_initialized: -32001,
  unsupported_version: -32002,
  invalid_state_dir: -32003,
  conflict: -32004,
  not_found: -32005,
  invalid_pipeline: -32006,
  permission_denied: -32007,
  sandbox_unavailable: -32008,
  budget_exceeded: -32010,
  runs_per_day_exceeded: -32011,
  timed_out: -32012,
  cancelled: -32013,
  credentials_missing: -32020,
  credentials_rejected: -32021,
  quota_exhausted: -32022,
  rate_limited: -32023,
  provider_unavailable: -32024,
  provider_refused: -32025,
  host_error: -32030,
  internal: -32099,
} as const;

export type ErrorKind = keyof typeof ERROR_CODES;

export interface RpcErrorObject {
  code: number;
  message: string;
  data: { kind: string; [key: string]: unknown };
}

export class RpcError extends Error {
  readonly kind: string;
  readonly code: number;
  readonly extras: Record<string, unknown>;

  constructor(kind: ErrorKind, message: string, extras: Record<string, unknown> = {}) {
    super(message);
    this.kind = kind;
    this.code = ERROR_CODES[kind];
    this.extras = extras;
  }

  toObject(): RpcErrorObject {
    return { code: this.code, message: this.message, data: { ...this.extras, kind: this.kind } };
  }

  static fromObject(error: RpcErrorObject): RpcError {
    const kind = error?.data?.kind;
    const known = typeof kind === "string" && Object.hasOwn(ERROR_CODES, kind);
    const { kind: _kind, ...extras } = error?.data ?? {};
    return new RpcError(
      known ? (kind as ErrorKind) : "host_error",
      typeof error?.message === "string" ? error.message : "The other side returned an error without a message.",
      known ? extras : { ...extras, reason: `unknown error kind ${String(kind)}` },
    );
  }
}

export function toRpcError(err: unknown): RpcError {
  if (err instanceof RpcError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new RpcError("internal", `Internal error: ${message}`);
}

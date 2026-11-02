// Human-readable logs: single-line JSON on stderr. stdout carries protocol messages only.

export type LogLevel = "debug" | "info" | "warn" | "error";

export function logLine(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  try {
    process.stderr.write(`${JSON.stringify({ level, time: new Date().toISOString(), msg, ...fields })}\n`);
  } catch {
    // The host closed stderr; logs are best effort.
  }
}

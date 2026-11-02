// The canonical form of a permissions object: sorted keys, no whitespace, zero values left out, so a
// field added to a later engine with its zero value does not change any existing hash.

import { createHash } from "node:crypto";

function isZero(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

function prune(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(prune);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      const item = prune((value as Record<string, unknown>)[key]);
      if (!isZero(item)) out[key] = item;
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(prune(value));
}

export function permissionsHash(permissions: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(permissions)).digest("hex")}`;
}

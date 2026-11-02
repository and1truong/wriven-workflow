// The advisory lock on <state_dir>/engine.lock. flock(2) because the kernel releases it when the
// holder dies, however it dies, so there is no stale-lock case to get wrong. Bun has no API for it.

import { dlopen, FFIType } from "bun:ffi";
import { closeSync, openSync } from "node:fs";

const LOCK_EX = 2;
const LOCK_NB = 4;

const libc = dlopen("libSystem.B.dylib", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});

// Returns a release function, or null when another process holds the lock.
export function tryLock(path: string): (() => void) | null {
  const fd = openSync(path, "a", 0o600);
  if (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
    closeSync(fd);
    return null;
  }
  return () => closeSync(fd);
}

// How `workflow` branches depend on each other. Shared by validation and the run, so both see the same
// graph. Spec: .agents/specs/composition.md#workflow.

import { parsePointer } from "./pointer.ts";

// Two pointers overlap when one is a prefix of the other, token by token.
export function pointersOverlap(a: string, b: string): boolean {
  const x = parsePointer(a);
  const y = parsePointer(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return false;
  return true;
}

// Branch id → the ids it waits for: siblings whose target its explicit `from` overlaps, and `after`.
// A branch without `from` reads the whole message, so nothing is inferred for it.
export function branchDependencies(branches: any[]): Map<string, string[]> {
  const deps = new Map<string, string[]>();
  for (const branch of branches) {
    const inferred = branch.from === undefined ? [] : branches.filter((other) => other !== branch && pointersOverlap(branch.from, other.target)).map((other) => other.id);
    deps.set(branch.id, [...new Set([...inferred, ...(branch.after ?? [])])]);
  }
  return deps;
}

// Branch ids in an order where every branch comes after what it waits for, siblings in document order;
// or the ids caught in a cycle.
export function branchOrder(branches: any[], deps: Map<string, string[]>): { order: string[] } | { cycle: string[] } {
  const order: string[] = [];
  const placed = new Set<string>();
  while (order.length < branches.length) {
    const ready = branches.find((b) => !placed.has(b.id) && deps.get(b.id)!.every((d) => placed.has(d)));
    if (!ready) return { cycle: branches.filter((b) => !placed.has(b.id)).map((b) => b.id) };
    order.push(ready.id);
    placed.add(ready.id);
  }
  return { order };
}

// Everything a branch waits for, directly or through others.
export function transitiveDependencies(id: string, deps: Map<string, string[]>): Set<string> {
  const out = new Set<string>();
  const visit = (current: string) => {
    for (const dep of deps.get(current) ?? []) {
      if (out.has(dep)) continue;
      out.add(dep);
      visit(dep);
    }
  };
  visit(id);
  return out;
}

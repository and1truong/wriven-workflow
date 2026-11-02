// What a component declares about the data it emits, so pointers can be checked before anything runs.

import { parsePointer } from "./pointer.ts";

export type Shape =
  | { kind: "unknown" }
  | { kind: "string" | "number" | "boolean" }
  | { kind: "array"; items: Shape }
  | { kind: "object"; props: Record<string, Shape> };

export const UNKNOWN: Shape = { kind: "unknown" };
export const STRING: Shape = { kind: "string" };
export const NUMBER: Shape = { kind: "number" };

export function object(props: Record<string, Shape>): Shape {
  return { kind: "object", props };
}

export type ShapeLookup = { found: true; shape: Shape } | { found: false };

export function shapeAt(shape: Shape, pointer: string): ShapeLookup {
  let current = shape;
  for (const token of parsePointer(pointer)) {
    if (current.kind === "unknown") return { found: true, shape: UNKNOWN };
    if (current.kind === "array" && /^(0|[1-9][0-9]*)$/.test(token)) current = current.items;
    else if (current.kind === "object" && Object.hasOwn(current.props, token)) current = current.props[token]!;
    else return { found: false };
  }
  return { found: true, shape: current };
}

// The shape after writing `value` at `pointer`, or null when the parent does not exist.
export function shapeWith(shape: Shape, pointer: string, value: Shape): Shape | null {
  const tokens = parsePointer(pointer);
  const last = tokens.pop();
  if (last === undefined) return null;
  const write = (node: Shape, path: string[]): Shape | null => {
    if (node.kind === "unknown") return UNKNOWN;
    const [head, ...rest] = path;
    if (head === undefined) {
      if (node.kind === "object") return object({ ...node.props, [last]: value });
      return node.kind === "array" ? node : null;
    }
    if (node.kind === "object" && Object.hasOwn(node.props, head)) {
      const child = write(node.props[head]!, rest);
      return child && object({ ...node.props, [head]: child });
    }
    if (node.kind === "array") {
      const items = write(node.items, rest);
      return items && { kind: "array", items };
    }
    return null;
  };
  return write(shape, tokens);
}

export function describeShape(shape: Shape): string {
  return shape.kind === "object" ? "an object" : shape.kind === "array" ? "an array" : `a ${shape.kind}`;
}

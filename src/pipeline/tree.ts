// Pipelines are trees: containers hold step lists. Everything that must see every step (validation,
// permissions, the supervisor's checks, the report) walks it through here.

import { COMPONENT_BY_TYPE } from "../components/definitions.ts";

// Compiled in, like the limits in ADR 008, and reported by `components.list`.
export const STRUCTURE_LIMITS = { nesting_depth: 4, steps: 64 };

export interface StepList {
  // Path of the list relative to its container, such as `steps` or `cases/0/steps`.
  field: string;
  steps: any[];
}

export interface TreeStep {
  config: any;
  path: string;
  // How many containers enclose this step.
  depth: number;
  // The enclosing container's config, or null at top level.
  parent: any | null;
}

export function childLists(config: any): StepList[] {
  const lists = COMPONENT_BY_TYPE.get(config?.type)?.children?.(config) ?? [];
  return lists.filter((list) => Array.isArray(list.steps));
}

// Every step in document order: a container comes before the steps it holds.
export function walkSteps(steps: any[], basePath: string, depth = 0, parent: any | null = null): TreeStep[] {
  const out: TreeStep[] = [];
  steps.forEach((config, i) => {
    const path = `${basePath}/${i}`;
    out.push({ config, path, depth, parent });
    for (const list of childLists(config)) out.push(...walkSteps(list.steps, `${path}/${list.field}`, depth + 1, config));
  });
  return out;
}

export function allSteps(pipeline: any): TreeStep[] {
  return walkSteps(pipeline.processors ?? [], "/processors");
}

export function stepById(pipeline: any, id: string): TreeStep | undefined {
  return allSteps(pipeline).find((s) => s.config.id === id);
}

// Whether a step keeps message ids: every output carries an input's id and none is made from nothing.
// A container keeps them when it does itself and every list inside it does.
export function preservesIds(config: any): boolean {
  if (COMPONENT_BY_TYPE.get(config?.type)?.preservesIds !== true) return false;
  return childLists(config).every((list) => list.steps.every(preservesIds));
}

export function containsType(steps: any[], type: string): boolean {
  return walkSteps(steps, "").some((s) => s.config.type === type);
}

// The containers around a step, outermost first.
export function ancestorsOf(pipeline: any, id: string): any[] {
  const find = (steps: any[], chain: any[]): any[] | null => {
    for (const config of steps) {
      if (config.id === id) return chain;
      for (const list of childLists(config)) {
        const found = find(list.steps, [...chain, config]);
        if (found) return found;
      }
    }
    return null;
  };
  return find(pipeline.processors ?? [], []) ?? [];
}

import type { OperationDef, OperationName } from "./types.js";

type AnyOperationDef = OperationDef<unknown, unknown>;

const registry = new Map<OperationName, AnyOperationDef>();

export function register<TParams, TResult>(
  def: OperationDef<TParams, TResult>
): void {
  if (registry.has(def.name)) {
    throw new Error(`Operation already registered: ${def.name}`);
  }
  registry.set(def.name, def as AnyOperationDef);
}

export function getOperation(name: string): AnyOperationDef | undefined {
  return registry.get(name as OperationName);
}

export function listOperations(): AnyOperationDef[] {
  return [...registry.values()];
}

export function operationNames(): OperationName[] {
  return [...registry.keys()];
}

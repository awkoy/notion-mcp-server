import { registerSharedSubSchemas } from "../schema/refs.js";

let initialized = false;

export async function initOperations(): Promise<void> {
  if (initialized) return;
  initialized = true;
  registerSharedSubSchemas();
  // Side-effect imports register every operation into the central registry.
  await Promise.all([
    import("./pages.js"),
    import("./blocks.js"),
    import("./databases.js"),
    import("./data-sources.js"),
    import("./comments.js"),
    import("./users.js"),
    import("./files.js"),
  ]);
}

export { listOperations, getOperation, operationNames } from "./registry.js";
export type { OperationName, OperationDef, OperationResult, BatchResult } from "./types.js";

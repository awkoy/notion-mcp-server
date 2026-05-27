#!/usr/bin/env node
import { startServer } from "./server/index.js";
import { registerAllTools } from "./tools/index.js";

async function main() {
  try {
    await registerAllTools();
    await startServer();
  } catch (error) {
    console.error(
      "Unhandled server error:",
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(
    "Unhandled server error:",
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
});

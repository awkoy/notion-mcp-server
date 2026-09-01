#!/usr/bin/env node
import { initOperations } from "./operations/index.js";
import { parseHttpConfig } from "./config/http.js";
import { startStdio } from "./server/index.js";
import { log } from "./utils/log.js";

async function main() {
  try {
    // Populate the global operation registry once, before any server instance
    // is built (the HTTP transport builds one server per session).
    await initOperations();

    const config = parseHttpConfig(process.env);
    if (config.transport === "http") {
      // Lazy import so the stdio path never loads the HTTP stack.
      const { startHttp } = await import("./server/http.js");
      await startHttp(config);
    } else {
      await startStdio();
    }
  } catch (error) {
    log.error(
      `Unhandled server error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  log.error(
    `Unhandled server error: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});

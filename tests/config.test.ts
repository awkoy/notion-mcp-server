import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CONFIG } from "../src/config/index.js";

describe("CONFIG.serverVersion", () => {
  it("matches the version in package.json", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as { version: string };
    expect(CONFIG.serverVersion).toBe(pkg.version);
  });
});

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { initOperations } from "../src/operations/index.js";
import { configureOperationAccess } from "../src/operations/access.js";
import { buildInstructions } from "../src/server/index.js";

const read = (file: string) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));

// The release PR bumps every version by hand; this is what catches a missed one.
describe("distribution manifests", () => {
  const pkg = read("package.json");

  it("server.json carries the package version", () => {
    const server = read("server.json");
    expect(server.version).toBe(pkg.version);
    for (const p of server.packages) expect(p.version).toBe(pkg.version);
  });

  it("gemini-extension.json carries the package version and starts the npm package", () => {
    const ext = read("gemini-extension.json");
    expect(ext.name).toBe(pkg.name);
    expect(ext.version).toBe(pkg.version);
    expect(ext.mcpServers.notion.command).toBe("npx");
    expect(ext.mcpServers.notion.args).toContain(`${pkg.name}@latest`);
    const envVars = ext.settings.map((s: { envVar: string }) => s.envVar);
    expect(envVars).toContain("NOTION_TOKEN");
    expect(ext.settings.find((s: { envVar: string }) => s.envVar === "NOTION_TOKEN").sensitive).toBe(true);
  });

  it("mcpb manifest declares a privacy policy and a sensitive token field", () => {
    const manifest = read("mcpb/manifest.json");
    expect(manifest.privacy_policies?.length).toBeGreaterThan(0);
    for (const url of manifest.privacy_policies) expect(url).toMatch(/^https:\/\//);
    expect(manifest.user_config.notion_token.sensitive).toBe(true);
    expect(manifest.user_config.notion_token.required).toBe(true);
  });
});

describe("server instructions", () => {
  beforeAll(async () => {
    await initOperations();
  });

  it("fit in the 2 KB that Claude Code shows the model", () => {
    const text = buildInstructions();
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(2000);
    expect(text).not.toMatch(/^[ \t]|\n[ \t]+\S/); // no leading or indented lines
    expect(text).toContain("notion_describe");
    expect(text).toContain("data_source_id");
  });

  it("mention a restricted surface when operations are disabled", () => {
    const prev = process.env.NOTION_READ_ONLY;
    process.env.NOTION_READ_ONLY = "true";
    configureOperationAccess();
    try {
      expect(buildInstructions()).toMatch(/Only \d+ of \d+ operations are enabled here \(read-only mode\)/);
    } finally {
      if (prev === undefined) delete process.env.NOTION_READ_ONLY;
      else process.env.NOTION_READ_ONLY = prev;
      configureOperationAccess();
    }
  });
});

import { describe, it, expect, beforeAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
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

  describe("Claude Code plugin", () => {
    const dir = "plugins/notion-mcp-server";

    it("plugin.json carries the package version and a sensitive token option", () => {
      const plugin = read(`${dir}/.claude-plugin/plugin.json`);
      expect(plugin.name).toBe(pkg.name);
      expect(plugin.version).toBe(pkg.version);
      expect(plugin.privacyPolicyUrl).toMatch(/^https:\/\//);
      expect(plugin.userConfig.notion_token.sensitive).toBe(true);
      expect(plugin.userConfig.notion_token.required).toBe(true);
    });

    // The directory blocks an unpinned npx launcher, so the pin moves with
    // every release.
    it(".mcp.json starts the npm package pinned to this version, with the token from userConfig", () => {
      const server = read(`${dir}/.mcp.json`).mcpServers.notion;
      expect(server.command).toBe("npx");
      expect(server.args).toEqual(["-y", `${pkg.name}@${pkg.version}`]);
      expect(server.env.NOTION_TOKEN).toBe("${user_config.notion_token}");
    });

    it("the marketplace entry points at the plugin folder under the same name", () => {
      const marketplace = read(".claude-plugin/marketplace.json");
      const entry = marketplace.plugins.find((p: { name: string }) => p.name === pkg.name);
      expect(entry?.source).toBe(`./${dir}`);
    });

    // Package-manager config next to an npx launcher fails the directory's
    // pre-submission checks, which is why the plugin is not the repo root.
    it("the plugin folder holds no package-manager files", () => {
      const files = readdirSync(new URL(`../${dir}`, import.meta.url), { recursive: true }).map(String);
      for (const banned of [".npmrc", "package.json", "package-lock.json", ".DS_Store"]) {
        expect(files.filter((f) => f.split("/").pop() === banned)).toEqual([]);
      }
    });
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

  it("say that destructive operations prompt when NOTION_CONFIRM_DESTRUCTIVE is on, and still fit", () => {
    const prevConfirm = process.env.NOTION_CONFIRM_DESTRUCTIVE;
    const prevBlock = process.env.NOTION_BLOCKED_OPERATIONS;
    process.env.NOTION_CONFIRM_DESTRUCTIVE = "true";
    // Worst case for the byte budget: the restricted-surface line and the
    // confirmation line both present.
    process.env.NOTION_BLOCKED_OPERATIONS = "delete_view";
    configureOperationAccess();
    try {
      const text = buildInstructions();
      expect(text).toContain("ask the user to confirm");
      expect(text).toContain("confirmation_declined");
      expect(text).toMatch(/do not retry/i);
      expect(text).toMatch(/Only \d+ of \d+ operations are enabled here/);
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(2000);
      expect(text).not.toMatch(/^[ \t]|\n[ \t]+\S/);
    } finally {
      if (prevConfirm === undefined) delete process.env.NOTION_CONFIRM_DESTRUCTIVE;
      else process.env.NOTION_CONFIRM_DESTRUCTIVE = prevConfirm;
      if (prevBlock === undefined) delete process.env.NOTION_BLOCKED_OPERATIONS;
      else process.env.NOTION_BLOCKED_OPERATIONS = prevBlock;
      configureOperationAccess();
    }
    expect(buildInstructions()).not.toContain("confirmation_declined");
  });
});

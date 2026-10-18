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

    // Codex prefers a root plugin.json over .codex-plugin/, and that portable
    // format cannot carry env_vars.
    it("has no root plugin.json for Codex to prefer", () => {
      expect(readdirSync(new URL(`../${dir}`, import.meta.url))).not.toContain("plugin.json");
    });
  });

  // Codex does not expand ${user_config.*}, so it gets its own MCP file that
  // forwards the token from the user's environment.
  describe("Codex plugin", () => {
    const dir = "plugins/notion-mcp-server";

    it(".codex-plugin/plugin.json carries the package version and points at the Codex MCP file", () => {
      const plugin = read(`${dir}/.codex-plugin/plugin.json`);
      expect(plugin.name).toBe(pkg.name);
      expect(plugin.version).toBe(pkg.version);
      expect(plugin.skills).toBe("./skills/");
      expect(plugin.mcpServers).toBe("./.codex-mcp.json");
    });

    it(".codex-mcp.json starts the npm package pinned to this version, with the token from env_vars", () => {
      const server = read(`${dir}/.codex-mcp.json`).mcpServers.notion;
      expect(server.command).toBe("npx");
      expect(server.args).toEqual(["-y", `${pkg.name}@${pkg.version}`]);
      expect(server.env_vars).toEqual(["NOTION_TOKEN", "NOTION_PAGE_ID", "NOTION_READ_ONLY"]);
      expect(server.env).toBeUndefined();
    });

    it("the marketplace entry points at the plugin folder under the same name", () => {
      const marketplace = read(".agents/plugins/marketplace.json");
      const entry = marketplace.plugins.find((p: { name: string }) => p.name === pkg.name);
      expect(entry?.source).toEqual({ source: "local", path: `./${dir}` });
      expect(entry?.policy).toEqual({ installation: "AVAILABLE", authentication: "ON_INSTALL" });
      expect(entry?.category).toBe("Productivity");
    });
  });

  describe("Cursor plugin", () => {
    const dir = "plugins/notion-mcp-server";

    // Without an explicit mcpServers, Cursor also loads Claude's .mcp.json and
    // its "notion" server wins, with the token left as ${user_config...}.
    it(".cursor-plugin/plugin.json carries the package version and points at mcp.json", () => {
      const plugin = read(`${dir}/.cursor-plugin/plugin.json`);
      expect(plugin.name).toBe(pkg.name);
      expect(plugin.version).toBe(pkg.version);
      expect(plugin.mcpServers).toBe("./mcp.json");
      expect(plugin.logo).toMatch(/^https:\/\/raw\.githubusercontent\.com\//);
      expect(plugin.variables.type).toBe("object");
      expect(plugin.variables.required).toContain("NOTION_TOKEN");
    });

    it("mcp.json starts the npm package pinned to this version, with the token from a variable", () => {
      const server = read(`${dir}/mcp.json`).mcpServers.notion;
      expect(server.command).toBe("npx");
      expect(server.args).toEqual(["-y", `${pkg.name}@${pkg.version}`]);
      expect(server.env.NOTION_TOKEN).toBe("${NOTION_TOKEN}");
    });

    // Cursor passes an unset variable through as the literal "${NAME}", so
    // only required variables may appear in mcp.json.
    it("every ${VAR} in mcp.json is a required variable", () => {
      const { variables } = read(`${dir}/.cursor-plugin/plugin.json`);
      const text = readFileSync(new URL(`../${dir}/mcp.json`, import.meta.url), "utf8");
      const placeholders = [...text.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]);
      expect(placeholders.length).toBeGreaterThan(0);
      for (const name of placeholders) {
        expect(Object.keys(variables.properties)).toContain(name);
        expect(variables.required).toContain(name);
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

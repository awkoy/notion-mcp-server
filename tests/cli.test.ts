import { describe, it, expect, beforeAll } from "vitest";
import { execFile, spawn as spawnChild } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { cliReply, parseCliArgs, usageText, versionText } from "../src/cli.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };
const BIN = fileURLToPath(new URL("../build/index.js", import.meta.url));
const README = fileURLToPath(new URL("../README.md", import.meta.url));
const run = promisify(execFile);

type Exit = { code: number; stdout: string; stderr: string };

// Spawn the built binary the way a shell would. A flag that fell through to
// the server would start the stdio transport and wait on stdin for ever; the
// timeout turns that into a failure instead of a hung suite.
async function spawn(...args: string[]): Promise<Exit> {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], {
      timeout: 10_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof e.code !== "number") throw err;
    return { code: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("command-line flags (spawned build/index.js)", () => {
  beforeAll(() => {
    if (!existsSync(BIN)) {
      throw new Error(
        `${BIN} is missing — run \`npm run build\` first (CI builds before it tests).`
      );
    }
  });

  it.each(["--version", "-v"])(
    "%s prints exactly the package version and exits 0",
    async (flag) => {
      const { code, stdout, stderr } = await spawn(flag);

      expect(code).toBe(0);
      expect(stdout).toBe(`${version}\n`);
      expect(stderr).toBe("");
    }
  );

  it.each(["--help", "-h"])("%s prints the usage and exits 0", async (flag) => {
    const { code, stdout, stderr } = await spawn(flag);

    expect(code).toBe(0);
    expect(stdout.startsWith("Usage: notion-mcp-server")).toBe(true);
    expect(stdout).toContain("MCP_TRANSPORT=http");
    expect(stdout).toContain("NOTION_TOKEN");
    expect(stdout).toContain("https://github.com/awkoy/notion-mcp-server#readme");
    expect(stderr).toBe("");
  });

  it.each([undefined, "", "   "])(
    "--require-token rejects missing or blank injected tokens before starting",
    async (token) => {
      // Model an isolated secret-manager child environment, not a real vault.
      const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
      try {
        await run(process.execPath, [BIN, "--require-token"], {
          env: { ...env, NOTION_TOKEN: token },
          timeout: 10_000,
        });
        throw new Error("strict startup unexpectedly succeeded");
      } catch (err) {
        const e = err as { code?: unknown; stdout?: string; stderr?: string };
        expect(e.code).toBe(1);
        expect(e.stdout).toBe("");
        expect(e.stderr).toBe("NOTION_TOKEN is missing or blank; refusing to start.\n");
      }
    }
  );

  it.each([
    ["--require-token", "--verison"],
    ["--version", "--require-token"],
    ["--require-token", "unexpected"],
  ])("rejects extra argument %s %s before launching", async (first, second) => {
    const { code, stdout, stderr } = await spawn(first, second);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain(`Unknown option: ${second}`);
  });

  it("starts stdio with a synthetic nonblank injected token", async () => {
    // This tests the positive startup gate, not a real vault or Notion login.
    // Never inherit a real credential into the child process.
    const child = spawnChild(process.execPath, [BIN, "--require-token"], {
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        NOTION_TOKEN: "synthetic-notion-token-not-valid",
        NOTION_READ_ONLY: "true",
        MCP_TRANSPORT: "stdio",
        HTTPS_PROXY: "http://127.0.0.1:9",
        HTTP_PROXY: "http://127.0.0.1:9",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`stdio startup was not observed: ${output}`));
        }, 10_000);
        child.stderr.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
          if (output.includes("running on stdio")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.once("exit", (code) => {
          if (!output.includes("running on stdio")) {
            clearTimeout(timer);
            reject(new Error(`server exited before stdio start (code ${code}): ${output}`));
          }
        });
      });
      expect(output).not.toContain("NOTION_TOKEN is missing or blank");
      expect(output).toContain("running on stdio");
    } finally {
      child.stdin.end();
      child.kill();
    }
  });

  it("rejects an unknown option on stderr with exit code 2", async () => {
    const { code, stdout, stderr } = await spawn("--verison");

    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr.startsWith("Unknown option: --verison\n")).toBe(true);
    expect(stderr).toContain("Usage: notion-mcp-server");
  });
});

describe("parseCliArgs", () => {
  it("runs the server when there are no arguments", () => {
    expect(parseCliArgs([])).toEqual({ kind: "run" });
  });

  it("opts in to strict token presence without changing default startup", () => {
    expect(parseCliArgs(["--require-token"])).toEqual({ kind: "run", requireToken: true });
  });

  it.each([
    ["--require-token", "--verison"],
    ["--version", "--require-token"],
    ["--help", "ignored"],
  ])("never ignores a trailing argument after %s", (first, extra) => {
    expect(parseCliArgs([first, extra])).toEqual({ kind: "unknown", option: extra });
  });

  it.each(["--version", "-v"])("%s asks for the version", (flag) => {
    expect(parseCliArgs([flag])).toEqual({ kind: "version" });
  });

  it.each(["--help", "-h"])("%s asks for help", (flag) => {
    expect(parseCliArgs([flag])).toEqual({ kind: "help" });
  });

  it("treats anything else, flag or positional, as an unknown option", () => {
    expect(parseCliArgs(["--port", "3000"])).toEqual({ kind: "unknown", option: "--port" });
    expect(parseCliArgs(["serve"])).toEqual({ kind: "unknown", option: "serve" });
  });
});

describe("cliReply", () => {
  it("version is the package.json version plus a newline, on stdout, exit 0", () => {
    expect(versionText()).toBe(`${version}\n`);
    expect(cliReply({ kind: "version" })).toEqual({
      text: `${version}\n`,
      stream: "stdout",
      exitCode: 0,
    });
  });

  it("help is the usage on stdout, exit 0", () => {
    expect(cliReply({ kind: "help" })).toEqual({
      text: usageText(),
      stream: "stdout",
      exitCode: 0,
    });
  });

  it("an unknown option names it, then the usage, on stderr, exit 2", () => {
    const reply = cliReply({ kind: "unknown", option: "--x" });

    expect(reply.stream).toBe("stderr");
    expect(reply.exitCode).toBe(2);
    expect(reply.text).toBe(`Unknown option: --x\n\n${usageText()}`);
  });
});

describe("usage text", () => {
  it("names both transports and links to the README", () => {
    const usage = usageText();

    expect(usage).toContain("stdio (default)");
    expect(usage).toContain("MCP_TRANSPORT=http");
    expect(usage).toContain("https://github.com/awkoy/notion-mcp-server#readme");
  });

  it("lists every environment variable the README documents", () => {
    // Every `| \`NAME\` …` table row in the README, ALL_CAPS names only, so
    // the operation, group-preset and resource tables do not count.
    const readme = readFileSync(README, "utf8");
    const names = new Set<string>();
    for (const line of readme.split("\n")) {
      if (!line.startsWith("| `")) continue;
      const firstCell = line.split("|")[1] ?? "";
      for (const m of firstCell.matchAll(/`([A-Z][A-Z0-9_]+)`/g)) names.add(m[1]);
    }
    expect(names.size).toBeGreaterThan(10);

    const usage = usageText();
    for (const name of names) {
      expect(usage, `${name} is in the README but not in --help`).toContain(name);
    }
  });
});

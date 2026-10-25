import { describe, it, expect } from "vitest";
import {
  isLoopbackHost,
  parseHttpConfig,
  unauthenticatedBindError,
} from "../src/config/http.js";

describe("parseHttpConfig", () => {
  it("defaults to stdio with no env", () => {
    const c = parseHttpConfig({});
    expect(c.transport).toBe("stdio");
    expect(c.port).toBe(3000);
    expect(c.host).toBe("127.0.0.1");
    expect(c.authToken).toBeUndefined();
  });

  it("selects http transport, case-insensitively, falling back to stdio on unknown", () => {
    expect(parseHttpConfig({ MCP_TRANSPORT: "http" }).transport).toBe("http");
    expect(parseHttpConfig({ MCP_TRANSPORT: "HTTP" }).transport).toBe("http");
    expect(parseHttpConfig({ MCP_TRANSPORT: "stdio" }).transport).toBe("stdio");
    expect(parseHttpConfig({ MCP_TRANSPORT: "bogus" }).transport).toBe("stdio");
  });

  it("overrides port and host", () => {
    const c = parseHttpConfig({ MCP_TRANSPORT: "http", PORT: "8080", HOST: "0.0.0.0" });
    expect(c.port).toBe(8080);
    expect(c.host).toBe("0.0.0.0");
  });

  it("treats blank/non-numeric/negative PORT as the default", () => {
    expect(parseHttpConfig({ PORT: "" }).port).toBe(3000);
    expect(parseHttpConfig({ PORT: "abc" }).port).toBe(3000);
    expect(parseHttpConfig({ PORT: "-5" }).port).toBe(3000);
  });

  it("honors PORT=0 (OS-assigned ephemeral port)", () => {
    expect(parseHttpConfig({ PORT: "0" }).port).toBe(0);
  });

  it("reads the auth token, treating blank as unset", () => {
    expect(parseHttpConfig({ MCP_AUTH_TOKEN: "secret" }).authToken).toBe("secret");
    expect(parseHttpConfig({ MCP_AUTH_TOKEN: "  " }).authToken).toBeUndefined();
  });

  it("parses and trims explicit allowed hosts/origins lists", () => {
    const c = parseHttpConfig({
      MCP_ALLOWED_HOSTS: "a.com, b.com ",
      MCP_ALLOWED_ORIGINS: "https://x.io",
    });
    expect(c.allowedHosts).toEqual(["a.com", "b.com"]);
    expect(c.allowedOrigins).toEqual(["https://x.io"]);
  });

  it("leaves allowed hosts/origins empty when unset (defaults are applied at bind time)", () => {
    const c = parseHttpConfig({});
    expect(c.allowedHosts).toEqual([]);
    expect(c.allowedOrigins).toEqual([]);
  });
});

describe("isLoopbackHost", () => {
  it.each(["127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST", "::1", "[::1]", "::ffff:127.0.0.1"])(
    "%s is loopback",
    (host) => expect(isLoopbackHost(host)).toBe(true)
  );

  it.each(["0.0.0.0", "::", "[::]", "192.168.1.10", "example.com", "128.0.0.1", "localhost.example.com"])(
    "%s is not",
    (host) => expect(isLoopbackHost(host)).toBe(false)
  );
});

describe("unauthenticatedBindError", () => {
  it("lets a loopback bind start without a token", () => {
    expect(unauthenticatedBindError(parseHttpConfig({ HOST: "127.0.0.1" }))).toBeNull();
    expect(unauthenticatedBindError(parseHttpConfig({}))).toBeNull();
  });

  it("refuses a non-loopback bind without MCP_AUTH_TOKEN and names the ways out", () => {
    const error = unauthenticatedBindError(parseHttpConfig({ HOST: "0.0.0.0" }));
    expect(error).toContain("0.0.0.0");
    expect(error).toContain("MCP_AUTH_TOKEN");
    expect(error).toContain("MCP_ALLOW_UNAUTHENTICATED");
  });

  it("lets a non-loopback bind start with a token", () => {
    expect(
      unauthenticatedBindError(parseHttpConfig({ HOST: "0.0.0.0", MCP_AUTH_TOKEN: "s" }))
    ).toBeNull();
  });

  it("lets a non-loopback bind start without a token only when explicitly allowed", () => {
    expect(
      unauthenticatedBindError(parseHttpConfig({ HOST: "0.0.0.0", MCP_ALLOW_UNAUTHENTICATED: "true" }))
    ).toBeNull();
    expect(
      unauthenticatedBindError(parseHttpConfig({ HOST: "0.0.0.0", MCP_ALLOW_UNAUTHENTICATED: "no" }))
    ).not.toBeNull();
  });
});

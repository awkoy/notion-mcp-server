import { describe, it, expect } from "vitest";
import {
  dotSegment,
  isInside,
  sensitiveZones,
  zoneOf,
} from "../src/utils/upload-paths.js";

// Each platform's rules, checked on any OS: the helpers take the platform,
// home directory and environment as arguments.

const MAC_HOME = "/Users/me";
const mac = (p: string, env: NodeJS.ProcessEnv = {}) =>
  zoneOf(p, sensitiveZones("darwin", MAC_HOME, env), "darwin");

const LINUX_HOME = "/home/me";
const linux = (p: string, env: NodeJS.ProcessEnv = {}) =>
  zoneOf(p, sensitiveZones("linux", LINUX_HOME, env), "linux");

const WIN_HOME = "C:\\Users\\me";
const WIN_ENV = {
  APPDATA: "C:\\Users\\me\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
};
const win = (p: string, env: NodeJS.ProcessEnv = WIN_ENV) =>
  zoneOf(p, sensitiveZones("win32", WIN_HOME, env), "win32");

describe("sensitive zones: macOS", () => {
  it.each([
    "/Users/me/Library/Application Support/Claude/claude_desktop_config.json",
    "/Users/me/Library/Application Support/Cursor/User/settings.json",
    "/Users/me/Library/Application Support/Windsurf/User/settings.json",
    "/Users/me/Library/Application Support/Code/User/mcp.json",
    "/Users/me/Library/Application Support/Code - Insiders/User/mcp.json",
    "/Users/me/Library/Application Support/Google/Chrome/Default/Cookies",
    "/Users/me/Library/Keychains/login.keychain-db",
  ])("refuses %s", (p) => {
    expect(mac(p)).toBe("/Users/me/Library");
  });

  // APFS ignores case by default, so a differently cased path opens the
  // same file.
  it("matches regardless of case", () => {
    expect(mac("/users/ME/library/application support/claude/claude_desktop_config.json")).toBe(
      "/Users/me/Library"
    );
  });

  it.each([
    "/Users/me/Library/Mobile Documents/com~apple~CloudDocs/report.pdf",
    "/Users/me/Library/CloudStorage/Dropbox/report.pdf",
    "/Users/me/Desktop/chart.png",
    "/Users/me/Documents/Library/notes.txt",
    "/Users/me/LibraryNotes/a.txt",
  ])("allows %s", (p) => {
    expect(mac(p)).toBeUndefined();
  });

  it("refuses /dev but has no /proc rule to need", () => {
    expect(mac("/dev/zero")).toBe("/dev");
  });
});

describe("sensitive zones: Windows", () => {
  it.each([
    ["C:\\Users\\me\\AppData\\Roaming\\Claude\\claude_desktop_config.json"],
    ["C:\\Users\\me\\AppData\\Roaming\\Cursor\\User\\settings.json"],
    ["C:\\Users\\me\\AppData\\Roaming\\Windsurf\\User\\settings.json"],
    ["C:\\Users\\me\\AppData\\Roaming\\Code\\User\\mcp.json"],
    ["C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cookies"],
  ])("refuses %s", (p) => {
    expect(win(p)).toBe("C:\\Users\\me\\AppData");
  });

  it("matches regardless of case and slash direction", () => {
    expect(win("c:/users/ME/appdata/roaming/claude/claude_desktop_config.json")).toBeDefined();
  });

  it("follows %APPDATA% when it is moved off the profile", () => {
    const env = { APPDATA: "D:\\Roaming" };
    expect(win("D:\\Roaming\\Claude\\claude_desktop_config.json", env)).toBe("D:\\Roaming");
  });

  it.each([
    "C:\\Users\\me\\Desktop\\chart.png",
    "C:\\Users\\me\\Documents\\AppData\\notes.txt",
    "D:\\Users\\me\\AppData\\copy.txt",
  ])("allows %s", (p) => {
    expect(win(p)).toBeUndefined();
  });

  it("has no Unix rules", () => {
    expect(win("C:\\proc\\self\\environ")).toBeUndefined();
  });
});

describe("sensitive zones: Linux", () => {
  it.each([
    ["/proc/self/environ", "/proc"],
    ["/proc/1/environ", "/proc"],
    ["/sys/class/net/eth0/address", "/sys"],
    ["/dev/zero", "/dev"],
    ["/run/secrets/db_password", "/run/secrets"],
    ["/var/run/secrets/kubernetes.io/serviceaccount/token", "/var/run/secrets"],
  ])("refuses %s", (p, zone) => {
    expect(linux(p)).toBe(zone);
  });

  it("is case-sensitive", () => {
    expect(linux("/PROC/self/environ")).toBeUndefined();
  });

  it.each([
    "/home/me/Desktop/chart.png",
    "/home/me/Library/a.txt",
    "/procurement/q3.pdf",
    "/devices/list.txt",
    "/run/media/me/USB/photo.jpg",
    "/tmp/report.pdf",
  ])("allows %s", (p) => {
    expect(linux(p)).toBeUndefined();
  });

  it("refuses the XDG base directories when they are set outside dot-names", () => {
    const env = {
      XDG_CONFIG_HOME: "/home/me/config",
      XDG_DATA_HOME: "/data/me",
      XDG_STATE_HOME: "/state/me",
    };
    expect(linux("/home/me/config/Claude/claude_desktop_config.json", env)).toBe("/home/me/config");
    expect(linux("/data/me/keyrings/login.keyring", env)).toBe("/data/me");
    expect(linux("/state/me/history", env)).toBe("/state/me");
  });

  it("ignores a relative or empty XDG variable", () => {
    expect(linux("/home/me/notes/a.txt", { XDG_CONFIG_HOME: "notes", XDG_DATA_HOME: "" })).toBeUndefined();
  });
});

describe("isInside", () => {
  it.each([
    ["/a/b", "/a", true],
    ["/a", "/a", true],
    ["/ab", "/a", false],
    ["/a/../b", "/a", false],
    ["/a/..b/c", "/a", true],
  ])("posix: %s inside %s is %s", (p, dir, expected) => {
    expect(isInside(p, dir, "linux")).toBe(expected);
  });

  it("win32: another drive is never inside", () => {
    expect(isInside("D:\\a\\b", "C:\\a", "win32")).toBe(false);
  });
});

describe("dotSegment", () => {
  it.each([
    ["/home/me/.ssh/id_ed25519", "linux", ".ssh"],
    ["/repo/.env", "linux", ".env"],
    ["/a/./b/../c", "linux", undefined],
    ["C:\\Users\\me\\.aws\\credentials", "win32", ".aws"],
    ["C:/Users/me/.aws/credentials", "win32", ".aws"],
  ] as const)("%s (%s) → %s", (p, platform, expected) => {
    expect(dotSegment(p, platform)).toBe(expected);
  });
});

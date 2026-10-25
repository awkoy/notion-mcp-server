import { posix, win32 } from "node:path";

/**
 * Where upload_file's path source may not read when NOTION_UPLOAD_ROOT is
 * unset: dot-named files and directories, the kernel's pseudo-filesystems and
 * runtime secrets, and the per-user app-data trees that MCP clients keep their
 * config in, this server's own NOTION_TOKEN included.
 *
 * Pure: the caller passes the platform, home directory and environment, so
 * every platform's rules can be tested on any OS.
 */

/** A directory to refuse, minus the subdirectories in `allow`. */
export type Zone = { dir: string; allow?: string[] };

function pathFor(platform: NodeJS.Platform) {
  return platform === "win32" ? win32 : posix;
}

// The default filesystems on Windows and macOS ignore case, so
// ~/library/application support is the same folder as ~/Library/Application Support.
function fold(p: string, platform: NodeJS.Platform): string {
  return platform === "win32" || platform === "darwin" ? p.toLowerCase() : p;
}

/** Whether `p` is `dir` or below it. Both must be absolute. */
export function isInside(p: string, dir: string, platform: NodeJS.Platform): boolean {
  const path = pathFor(platform);
  const rel = path.relative(fold(dir, platform), fold(p, platform));
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

/**
 * The first dot-named segment of a path: ~/.ssh, ~/.aws, ~/.config, .env,
 * .git, .npmrc. Credentials and tokens live under names like these.
 */
export function dotSegment(p: string, platform: NodeJS.Platform): string | undefined {
  const segments = platform === "win32" ? p.split(/[\\/]/) : p.split("/");
  return segments.find((s) => s.startsWith(".") && s !== "." && s !== "..");
}

/**
 * The directories outside dot-names that hold credentials or never-ending
 * files. Lexical: the caller resolves symlinks in them too.
 *
 * - /proc, /sys, /dev: /proc/self/environ is a regular file of size 0 that
 *   holds the server's environment, NOTION_TOKEN included, and /dev/zero
 *   never ends.
 * - /run/secrets and /var/run/secrets: Docker and Kubernetes secrets, the
 *   pod's service-account token among them.
 * - macOS ~/Library: Claude Desktop's claude_desktop_config.json, where the
 *   README puts NOTION_TOKEN, and the same for Cursor, Windsurf and VS Code
 *   under Application Support, plus keychains, cookies and mail. iCloud
 *   Drive and the cloud-storage folders (Dropbox, Google Drive, OneDrive)
 *   also sit under ~/Library and hold ordinary documents, so they stay open.
 * - Windows %APPDATA% and %LOCALAPPDATA% (~\AppData): the same configs, and
 *   browser profiles.
 * - XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_STATE_HOME when set: they default to
 *   dot-named folders, but can be pointed anywhere.
 */
export function sensitiveZones(
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv
): Zone[] {
  const path = pathFor(platform);
  const absolute = (dir: string | undefined): dir is string => !!dir && path.isAbsolute(dir);
  if (platform === "win32") {
    return [path.join(home, "AppData"), env.APPDATA, env.LOCALAPPDATA]
      .filter(absolute)
      .map((dir) => ({ dir }));
  }
  const zones: Zone[] = ["/proc", "/sys", "/dev", "/run/secrets", "/var/run/secrets"].map(
    (dir) => ({ dir })
  );
  if (platform === "darwin") {
    const library = path.join(home, "Library");
    zones.push({
      dir: library,
      allow: [path.join(library, "Mobile Documents"), path.join(library, "CloudStorage")],
    });
  }
  for (const dir of [env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME]) {
    if (absolute(dir)) zones.push({ dir });
  }
  return zones;
}

/** The zone `p` falls in, or undefined when it falls in none. */
export function zoneOf(p: string, zones: Zone[], platform: NodeJS.Platform): string | undefined {
  return zones.find(
    (z) =>
      isInside(p, z.dir, platform) && !(z.allow ?? []).some((a) => isInside(p, a, platform))
  )?.dir;
}

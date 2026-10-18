# Claude plugin directory submission

A draft of the answers for listing the Claude Code plugin in [`plugins/notion-mcp-server`](../plugins/notion-mcp-server) in the Claude directory. The directory no longer accepts MCPB bundles, and a local MCP server can be listed only inside a plugin. The `.mcpb` release asset stays as it is, for sideloading into Claude Desktop.

Status: **draft, not submitted.** The submission is made at [claude.ai/directory/manage](https://claude.ai/directory/manage) → **Plugin bundle**, following [the submission guide](https://claude.com/docs/plugins/submit).

## Before submitting

1. **Confirm the plugin name.** `notion-mcp-server` is permanent once listed: it is the install id (`notion-mcp-server@…`) and the prefix of every tool name (`mcp__plugin_notion-mcp-server_notion__notion_read`). The display name, `Notion MCP Server (community)`, can change later.
2. **Expect a manual review, not a rejection.** The automated checks hold a plugin for a reviewer when it:
   - runs a pinned `npx` package (`.mcp.json` runs `notion-mcp-server@3.2.0`), and
   - has a name containing a brand it doesn't own ("Notion").

   The display name says *community* and the description says *not made by Notion* so that the reviewer sees this at once.
3. **Choose the branch or tag to list.** The form asks for one. `main` works, but `claude plugin tag plugins/notion-mcp-server` creates a `notion-mcp-server--v3.2.0` tag after checking that `plugin.json` and the marketplace entry agree. A tag can't move ahead of npm.
4. **Run the checks one last time:**

   ```bash
   claude plugin validate ./plugins/notion-mcp-server
   claude plugin validate .
   npx vitest run tests/manifests.test.ts
   ```

## Releasing a new version afterwards

Every release changes three things together, and `tests/manifests.test.ts` fails if one is missed:

- the `version` in `plugins/notion-mcp-server/.claude-plugin/plugin.json`;
- the pin in `plugins/notion-mcp-server/.mcp.json` (`notion-mcp-server@<version>`), because the directory blocks an unpinned `npx` launcher;
- `package.json`, which the other two follow.

Claude Code updates installed plugins only when the plugin version changes, so a release that skips the bump never reaches plugin users. The pinned version must be on npm before users install it. The `v*` tag publishes to npm within minutes, so push the tag as soon as the release PR merges.

## Form answers

### Source

| Field | Answer |
| --- | --- |
| Repository | `https://github.com/awkoy/notion-mcp-server` |
| Plugin path | `plugins/notion-mcp-server` |
| Branch or tag | `main`, or `notion-mcp-server--v3.2.0` (see above) |

### Listing

The form reads the listing from `plugin.json` and the plugin's `README.md`: name, display name, description, author, icon, documentation, support and privacy URLs, license and keywords. Check the preview after the validation step.

If a longer description is asked for:

> Connect Claude to Notion with a token instead of OAuth. The plugin runs the open-source notion-mcp-server on your computer and adds a skill that teaches Claude how to work with Notion efficiently. Claude can search pages and databases, read pages as markdown, filter databases with a typed `where` shorthand, create and edit pages and rows with plain values, comment, and upload files. It can also batch many edits into a single call, with atomic rollback and idempotent retries. The server exposes three tools rather than one per endpoint, which keeps tool schemas and responses small in Claude's context. An optional read-only mode turns off every write. Community project, not made by or affiliated with Notion.

### Data handling

| Question | Draft answer |
| --- | --- |
| Does the plugin process personal data? | Yes, whatever the user's Notion workspace holds, which can include names, email addresses (for example from `list_users`), and page content. It reads and writes that data only on the user's request, with the user's own token. |
| Is data sent anywhere other than the service it connects to? | No. The server runs locally and talks only to `api.notion.com` over HTTPS. `get_image` fetches only the signed file URLs that Notion returns for files it hosts. If the user sets `HTTPS_PROXY`, traffic goes through that proxy. There is no telemetry, no analytics, and no server operated by the author. |
| Data retention | None on disk. While the process runs it keeps two in-memory caches: database schemas for 5 minutes, and batch results under an `idempotency_key` for 5 minutes. Both are gone when the process exits. The token is held by Claude Code in the system keychain (`sensitive` user config). |
| Directed at users under 18? | No. |
| Privacy policy | `https://github.com/awkoy/notion-mcp-server#-privacy` |

### Compliance contact

The owner fills this in. `package.json` lists `y.boikodeveloper@gmail.com`.

### Updates

Either a GitHub webhook or the scheduled check. The scheduled check needs no setup. A new version reaches users only when `plugin.json`'s `version` changes, which the release checklist above guarantees.

## Notes for the reviewer

- **To test:** create a Personal Access Token at [app.notion.com/developers/tokens](https://app.notion.com/developers/tokens), then install with `/plugin marketplace add awkoy/notion-mcp-server` and `/plugin install notion-mcp-server@awkoy`. Paste the token when Claude Code asks. Turn on **Read-only mode** to try it without any writes.
- **Prompts to try:**
  - *Find my Tasks database and list what's overdue.*
  - *Summarise the page I just linked.*
  - *Mark these three rows Done.* (This one shows a batched write.)
- **Where it runs:** the server works in Claude Code and in Cowork sessions on the user's computer. Cowork does not prompt for user config, so it skips a server whose required token has no value. In practice the plugin is for Claude Code.
- **Source:**
  - Server: [`src/`](../src)
  - npm package: [`notion-mcp-server`](https://www.npmjs.com/package/notion-mcp-server)
  - Releases are published from tags by [`publish-npm.yml`](../.github/workflows/publish-npm.yml) with npm provenance.

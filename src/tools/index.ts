import { server } from "../server/index.js";
import { PAGES_OPERATION_SCHEMA } from "../schema/page.js";
import { BLOCKS_OPERATION_SCHEMA } from "../schema/blocks.js";
import { DATABASE_OPERATION_SCHEMA } from "../schema/database.js";
import { COMMENTS_OPERATION_SCHEMA } from "../schema/comments.js";
import { USERS_OPERATION_SCHEMA } from "../schema/users.js";
import { registerPagesOperationTool } from "./pages.js";
import { registerBlocksOperationTool } from "./blocks.js";
import { registerDatabaseOperationTool } from "./database.js";
import { registerCommentsOperationTool } from "./comments.js";
import { registerUsersOperationTool } from "./users.js";

// Each server.registerTool call below is suppressed with @ts-expect-error TS2589
// because the project's schemas (ZodEffects<ZodDiscriminatedUnion<...>>) exceed
// TypeScript's type-instantiation depth limit when fed through registerTool's
// inputSchema/ToolCallback generic chain. The suppression is site-local and the
// SDK's real signature is preserved — extra, outputSchema, _meta, and the
// RegisteredTool return value all remain accessible to future code.

export const registerAllTools = () => {
  // @ts-expect-error TS2589 — ZodEffects<ZodDiscriminatedUnion<...>> exceeds TS instantiation depth
  server.registerTool(
    "notion_pages",
    {
      title: "Notion Pages",
      description:
        "Perform various page operations (create, archive, restore, search, update)",
      inputSchema: PAGES_OPERATION_SCHEMA,
      annotations: {
        title: "Notion Pages",
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    registerPagesOperationTool
  );

  // @ts-expect-error TS2589 — ZodEffects<ZodDiscriminatedUnion<...>> exceeds TS instantiation depth
  server.registerTool(
    "notion_blocks",
    {
      title: "Notion Blocks",
      description:
        "Perform various block operations (retrieve, update, delete, append children, batch operations)",
      inputSchema: BLOCKS_OPERATION_SCHEMA,
      annotations: {
        title: "Notion Blocks",
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    registerBlocksOperationTool
  );

  // @ts-expect-error TS2589 — ZodEffects<ZodDiscriminatedUnion<...>> exceeds TS instantiation depth
  server.registerTool(
    "notion_database",
    {
      title: "Notion Database",
      description:
        "Perform various database operations (create, query, update)",
      inputSchema: DATABASE_OPERATION_SCHEMA,
      annotations: {
        title: "Notion Database",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    registerDatabaseOperationTool
  );

  // @ts-expect-error TS2589 — ZodEffects<ZodDiscriminatedUnion<...>> exceeds TS instantiation depth
  server.registerTool(
    "notion_comments",
    {
      title: "Notion Comments",
      description:
        "Perform various comment operations (get, add to page, add to discussion)",
      inputSchema: COMMENTS_OPERATION_SCHEMA,
      annotations: {
        title: "Notion Comments",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    registerCommentsOperationTool
  );

  // @ts-expect-error TS2589 — ZodEffects<ZodDiscriminatedUnion<...>> exceeds TS instantiation depth
  server.registerTool(
    "notion_users",
    {
      title: "Notion Users",
      description: "Perform various user operations (list, get, get bot)",
      inputSchema: USERS_OPERATION_SCHEMA,
      annotations: {
        title: "Notion Users",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    registerUsersOperationTool
  );
};

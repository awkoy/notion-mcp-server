import { z } from "zod";
import { COLOR_SCHEMA } from "./color.js";
import { ICON_SCHEMA } from "./icon.js";
import { RICH_TEXT_ITEM_REQUEST_SCHEMA } from "./rich-text.js";
import { preprocessJson } from "./preprocess.js";
import { LANGUAGE_SCHEMA } from "./lang.js";
import { FILE_SCHEMA } from "./file.js";

export const BASE_BLOCK_REQUEST_SCHEMA = z.object({
  type: z.string().describe("Type of block"),
  object: z.literal("block").optional().describe("Object type identifier"),
  created_time: z
    .string()
    .optional()
    .describe("ISO timestamp of block creation"),
  last_edited_time: z
    .string()
    .optional()
    .describe("ISO timestamp of last edit"),
  has_children: z
    .boolean()
    .optional()
    .describe("Whether block has child blocks"),
  archived: z.boolean().optional().describe("Whether block is archived"),
  in_trash: z.boolean().optional().describe("Whether block is in trash (2026-03-11 surface)"),
});

export const TEXT_BLOCK_BASE_REQUEST_SCHEMA = z.object({
  rich_text: z
    .array(RICH_TEXT_ITEM_REQUEST_SCHEMA)
    .describe("Array of rich text content"),
  color: COLOR_SCHEMA.optional().describe("Color of the block"),
});

export const PARAGRAPH_BLOCK_REQUEST_SCHEMA = BASE_BLOCK_REQUEST_SCHEMA.extend({
  type: z.literal("paragraph").describe("Paragraph block type"),
  paragraph: TEXT_BLOCK_BASE_REQUEST_SCHEMA.describe("Paragraph block content"),
});

export const HEADING1_BLOCK_REQUEST_SCHEMA = BASE_BLOCK_REQUEST_SCHEMA.extend({
  type: z.literal("heading_1").describe("Heading 1 block type"),
  heading_1: TEXT_BLOCK_BASE_REQUEST_SCHEMA.extend({
    is_toggleable: z
      .boolean()
      .optional()
      .describe("Whether heading can be toggled"),
  }).describe("Heading 1 block content"),
});

export const HEADING2_BLOCK_REQUEST_SCHEMA = BASE_BLOCK_REQUEST_SCHEMA.extend({
  type: z.literal("heading_2").describe("Heading 2 block type"),
  heading_2: TEXT_BLOCK_BASE_REQUEST_SCHEMA.extend({
    is_toggleable: z
      .boolean()
      .optional()
      .describe("Whether heading can be toggled"),
  }).describe("Heading 2 block content"),
});

export const HEADING3_BLOCK_REQUEST_SCHEMA = BASE_BLOCK_REQUEST_SCHEMA.extend({
  type: z.literal("heading_3").describe("Heading 3 block type"),
  heading_3: TEXT_BLOCK_BASE_REQUEST_SCHEMA.extend({
    is_toggleable: z
      .boolean()
      .optional()
      .describe("Whether heading can be toggled"),
  }).describe("Heading 3 block content"),
});

export const HEADING4_BLOCK_REQUEST_SCHEMA = BASE_BLOCK_REQUEST_SCHEMA.extend({
  type: z.literal("heading_4").describe("Heading 4 block type"),
  heading_4: TEXT_BLOCK_BASE_REQUEST_SCHEMA.extend({
    is_toggleable: z
      .boolean()
      .optional()
      .describe("Whether heading can be toggled"),
  }).describe("Heading 4 block content"),
});

export const TAB_BLOCK_REQUEST_SCHEMA = BASE_BLOCK_REQUEST_SCHEMA.extend({
  type: z.literal("tab").describe("Tab block type"),
  tab: z
    .object({
      icon: ICON_SCHEMA.optional(),
    })
    .describe("Tab block content"),
});

export const QUOTE_BLOCK_REQUEST_SCHEMA = BASE_BLOCK_REQUEST_SCHEMA.extend({
  type: z.literal("quote").describe("Quote block type"),
  quote: TEXT_BLOCK_BASE_REQUEST_SCHEMA.describe("Quote block content"),
});

export const CALLOUT_BLOCK_REQUEST_SCHEMA = BASE_BLOCK_REQUEST_SCHEMA.extend({
  type: z.literal("callout").describe("Callout block type"),
  callout: TEXT_BLOCK_BASE_REQUEST_SCHEMA.extend({
    icon: ICON_SCHEMA.optional().describe("Icon for the callout"),
  }).describe("Callout block content"),
});

export const TOGGLE_BLOCK_REQUEST_SCHEMA = BASE_BLOCK_REQUEST_SCHEMA.extend({
  type: z.literal("toggle").describe("Toggle block type"),
  toggle: TEXT_BLOCK_BASE_REQUEST_SCHEMA.describe("Toggle block content"),
});

export const BULLETED_LIST_ITEM_BLOCK_REQUEST_SCHEMA =
  BASE_BLOCK_REQUEST_SCHEMA.extend({
    type: z
      .literal("bulleted_list_item")
      .describe("Bulleted list item block type"),
    bulleted_list_item: TEXT_BLOCK_BASE_REQUEST_SCHEMA.describe(
      "Bulleted list item block content"
    ),
  });

export const NUMBERED_LIST_ITEM_BLOCK_REQUEST_SCHEMA =
  BASE_BLOCK_REQUEST_SCHEMA.extend({
    type: z
      .literal("numbered_list_item")
      .describe("Numbered list item block type"),
    numbered_list_item: TEXT_BLOCK_BASE_REQUEST_SCHEMA.describe(
      "Numbered list item block content"
    ),
  });

export const TO_DO_BLOCK_REQUEST_SCHEMA = BASE_BLOCK_REQUEST_SCHEMA.extend({
  type: z.literal("to_do").describe("To-do block type"),
  to_do: TEXT_BLOCK_BASE_REQUEST_SCHEMA.extend({
    checked: z.boolean().optional().describe("Whether the to-do is checked"),
  }).describe("To-do block content"),
});

export const CODE_BLOCK_REQUEST_SCHEMA = BASE_BLOCK_REQUEST_SCHEMA.extend({
  type: z.literal("code").describe("Code block type"),
  code: TEXT_BLOCK_BASE_REQUEST_SCHEMA.extend({
    language: LANGUAGE_SCHEMA,
  }).describe("Code block content"),
});

export const DIVIDER_BLOCK_REQUEST_SCHEMA = BASE_BLOCK_REQUEST_SCHEMA.extend({
  type: z.literal("divider").describe("Divider block type"),
  divider: z.object({}).describe("Divider block content"),
});

export const IMAGE_BLOCK_REQUEST_SCHEMA = BASE_BLOCK_REQUEST_SCHEMA.extend({
  type: z.literal("image").describe("Image block type"),
  image: z
    .object({
      ...FILE_SCHEMA.shape,
      caption: z
        .array(RICH_TEXT_ITEM_REQUEST_SCHEMA)
        .optional()
        .describe("Image caption"),
    })
    .describe("Image block content"),
});

export const TEXT_BLOCK_REQUEST_SCHEMA = z.preprocess(
  preprocessJson,
  z
    .discriminatedUnion("type", [
      PARAGRAPH_BLOCK_REQUEST_SCHEMA,
      HEADING1_BLOCK_REQUEST_SCHEMA,
      HEADING2_BLOCK_REQUEST_SCHEMA,
      HEADING3_BLOCK_REQUEST_SCHEMA,
      HEADING4_BLOCK_REQUEST_SCHEMA,
      QUOTE_BLOCK_REQUEST_SCHEMA,
      CALLOUT_BLOCK_REQUEST_SCHEMA,
      TOGGLE_BLOCK_REQUEST_SCHEMA,
      BULLETED_LIST_ITEM_BLOCK_REQUEST_SCHEMA,
      NUMBERED_LIST_ITEM_BLOCK_REQUEST_SCHEMA,
      TO_DO_BLOCK_REQUEST_SCHEMA,
      CODE_BLOCK_REQUEST_SCHEMA,
      DIVIDER_BLOCK_REQUEST_SCHEMA,
      IMAGE_BLOCK_REQUEST_SCHEMA,
      TAB_BLOCK_REQUEST_SCHEMA,
    ])
    .describe("Union of all possible text block request types")
);


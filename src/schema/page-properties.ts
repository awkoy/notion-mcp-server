import { z } from "zod";
import { notionId } from "./id.js";
import {
  RICH_TEXT_ITEM_REQUEST_SCHEMA,
  TEXT_RICH_TEXT_ITEM_REQUEST_SCHEMA,
} from "./rich-text.js";

export const CHECKBOX_PROPERTY_VALUE_SCHEMA = z.object({
  checkbox: z.boolean(),
});

export const DATE_PROPERTY_VALUE_SCHEMA = z.object({
  date: z.object({
    start: z.string(),
    end: z.string().optional(),
  }),
});

export const EMAIL_PROPERTY_VALUE_SCHEMA = z.object({
  email: z.email(),
});

export const FILES_PROPERTY_VALUE_SCHEMA = z.object({
  // Unlike a file on a block or a cover, a file property value only takes the
  // `type` tag optionally: Notion tells the arms apart by which key is present.
  // An external file needs a `name`; an uploaded one already has its filename,
  // so `name` is optional there (SDK: FileUploadWithOptionalNameRequest).
  files: z.array(
    z.union([
      z.object({
        type: z.literal("external").optional(),
        name: z.string(),
        external: z.object({
          url: z.url({ protocol: /^https?$/ }),
        }),
      }),
      z.object({
        type: z.literal("file_upload").optional(),
        name: z.string().optional(),
        file_upload: z.object({
          id: z.string().describe("file_upload_id returned by upload_file"),
        }),
      }),
    ])
  ),
});

export const MULTI_SELECT_PROPERTY_VALUE_SCHEMA = z.object({
  multi_select: z.array(
    z.object({
      id: z.string().optional(),
      name: z.string().optional(),
    })
  ),
});

export const NUMBER_PROPERTY_VALUE_SCHEMA = z.object({ number: z.number() });

export const PEOPLE_PROPERTY_VALUE_SCHEMA = z.object({
  people: z.array(
    z.object({
      object: z.literal("user"),
      id: notionId(),
    })
  ),
});

export const PHONE_NUMBER_PROPERTY_VALUE_SCHEMA = z.object({
  phone_number: z.string(),
});

export const RELATION_PROPERTY_VALUE_SCHEMA = z.object({
  relation: z.array(
    z.object({
      id: notionId(),
    })
  ),
});

export const RICH_TEXT_PROPERTY_VALUE_SCHEMA = z.object({
  rich_text: z.array(RICH_TEXT_ITEM_REQUEST_SCHEMA),
});

export const SELECT_PROPERTY_VALUE_SCHEMA = z.object({
  select: z.object({
    name: z.string(),
  }),
});

export const STATUS_PROPERTY_VALUE_SCHEMA = z.object({
  status: z.object({ name: z.string() }),
});

export const TITLE_PROPERTY_VALUE_SCHEMA = z.object({
  title: z.array(TEXT_RICH_TEXT_ITEM_REQUEST_SCHEMA),
});

export const URL_PROPERTY_VALUE_SCHEMA = z.object({
  url: z.url({ protocol: /^https?$/ }),
});

export const VERIFICATION_PROPERTY_VALUE_SCHEMA = z.object({
  verification: z
    .object({
      state: z.enum(["verified", "unverified", "expired"]),
      verified_by: z
        .object({ id: z.string(), object: z.literal("user").optional() })
        .optional(),
      date: z
        .object({ start: z.string(), end: z.string().nullable().optional() })
        .nullable()
        .optional(),
    })
    .describe("Verification property value"),
});

// ── Property value: typed objects plus plain-value shorthand ─────────────────

/** `{ start, end?, time_zone? }` — a date value without the `date` wrapper. */
export const DATE_SHORTHAND_SCHEMA = z.object({
  start: z.string(),
  end: z.string().nullable().optional(),
  time_zone: z.string().nullable().optional(),
});

/** `{ name?, url }` — an external file without the `external` wrapper. */
export const FILE_SHORTHAND_SCHEMA = z.object({
  name: z.string().optional(),
  url: z.string(),
});

/**
 * One page property value. Either the typed Notion object (`{ select: { name } }`,
 * `{ date: { start } }`, …) or a plain value that the server coerces from the
 * data source's property type: string, number, boolean, null (clear), an array
 * of strings (multi_select / people / relation), a `{ start, end? }` date, an
 * array of `{ name, url }` files, or a bare rich-text array.
 */
export const PROPERTY_VALUE_SCHEMA = z
  .union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(z.string()),
    DATE_SHORTHAND_SCHEMA,
    z.array(FILE_SHORTHAND_SCHEMA),
    z.array(RICH_TEXT_ITEM_REQUEST_SCHEMA),
    TITLE_PROPERTY_VALUE_SCHEMA,
    RICH_TEXT_PROPERTY_VALUE_SCHEMA,
    NUMBER_PROPERTY_VALUE_SCHEMA,
    SELECT_PROPERTY_VALUE_SCHEMA,
    MULTI_SELECT_PROPERTY_VALUE_SCHEMA,
    STATUS_PROPERTY_VALUE_SCHEMA,
    DATE_PROPERTY_VALUE_SCHEMA,
    PEOPLE_PROPERTY_VALUE_SCHEMA,
    FILES_PROPERTY_VALUE_SCHEMA,
    CHECKBOX_PROPERTY_VALUE_SCHEMA,
    URL_PROPERTY_VALUE_SCHEMA,
    EMAIL_PROPERTY_VALUE_SCHEMA,
    PHONE_NUMBER_PROPERTY_VALUE_SCHEMA,
    RELATION_PROPERTY_VALUE_SCHEMA,
    VERIFICATION_PROPERTY_VALUE_SCHEMA,
  ])
  .describe(
    "Property value. For a database row a plain value is enough — the server types it from the property definition: a string for title / rich_text / select / status / date / url / email / phone_number, a number, true/false, an array of names or ids for multi_select / people / relation, { start, end? } for a date range, [{ name, url }] for files, null to clear. Typed Notion objects such as { select: { name } } are accepted too."
  );

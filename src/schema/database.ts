import { z } from "zod";
import { preprocessJson } from "./preprocess.js";
import { NUMBER_FORMAT } from "./number.js";

export const EMPTY_OBJECT_SCHEMA = z.record(z.string(), z.never()).default({});
export const SELECT_COLOR_SCHEMA = z.enum([
  "default",
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
]);

// Database property schemas
// 1. Title property
export const TITLE_DB_PROPERTY_SCHEMA = z.object({
  type: z.literal("title").describe("Title property type"),
  title: EMPTY_OBJECT_SCHEMA.describe(
    "There is no additional property configuration."
  ),
  description: z.string().optional().describe("Property description"),
});

// 2. Rich text property
export const RICH_TEXT_DB_PROPERTY_SCHEMA = z.object({
  type: z.literal("rich_text").describe("Rich text property type"),
  rich_text: EMPTY_OBJECT_SCHEMA.describe(
    "There is no additional property configuration."
  ),
  description: z.string().optional().describe("Property description"),
});

// 3. Number property

export const NUMBER_DB_PROPERTY_SCHEMA = z.object({
  type: z.literal("number").describe("Number property type"),
  number: z
    .object({
      format: NUMBER_FORMAT.describe("Number format"),
    })
    .describe("Number property configuration"),
  description: z.string().optional().describe("Property description"),
});

// 4. Select property
export const SELECT_OPTION_SCHEMA = z.object({
  name: z.string().describe("Name of the select option"),
  color: SELECT_COLOR_SCHEMA.optional().describe("Color of the select option"),
  id: z.string().optional().describe("ID of the select option"),
});

export const SELECT_DB_PROPERTY_SCHEMA = z.object({
  type: z.literal("select").describe("Select property type"),
  select: z
    .object({
      options: z
        .array(SELECT_OPTION_SCHEMA)
        .optional()
        .describe("Select options"),
    })
    .describe("Select property configuration"),
  description: z.string().optional().describe("Property description"),
});

// 5. Multi-select property
export const MULTI_SELECT_DB_PROPERTY_SCHEMA = z.object({
  type: z.literal("multi_select").describe("Multi-select property type"),
  multi_select: z
    .object({
      options: z
        .array(SELECT_OPTION_SCHEMA)
        .optional()
        .describe("Multi-select options"),
    })
    .describe("Multi-select property configuration"),
  description: z.string().optional().describe("Property description"),
});

// 6. Date property
export const DATE_DB_PROPERTY_SCHEMA = z.object({
  type: z.literal("date").describe("Date property type"),
  date: EMPTY_OBJECT_SCHEMA.describe(
    "There is no additional property configuration."
  ),
  description: z.string().optional().describe("Property description"),
});

// 7. People property
export const PEOPLE_DB_PROPERTY_SCHEMA = z.object({
  type: z.literal("people").describe("People property type"),
  people: EMPTY_OBJECT_SCHEMA.describe(
    "There is no additional property configuration."
  ),
  description: z.string().optional().describe("Property description"),
});

// 8. Files property
export const FILES_DB_PROPERTY_SCHEMA = z.object({
  type: z.literal("files").describe("Files property type"),
  files: EMPTY_OBJECT_SCHEMA.describe(
    "There is no additional property configuration."
  ),
  description: z.string().optional().describe("Property description"),
});

// 9. Checkbox property
export const CHECKBOX_DB_PROPERTY_SCHEMA = z.object({
  type: z.literal("checkbox").describe("Checkbox property type"),
  checkbox: EMPTY_OBJECT_SCHEMA.describe(
    "There is no additional property configuration."
  ),
  description: z.string().optional().describe("Property description"),
});

// 10. URL property
export const URL_DB_PROPERTY_SCHEMA = z.object({
  type: z.literal("url").describe("URL property type"),
  url: EMPTY_OBJECT_SCHEMA.describe(
    "There is no additional property configuration."
  ),
  description: z.string().optional().describe("Property description"),
});

// 11. Email property
export const EMAIL_DB_PROPERTY_SCHEMA = z.object({
  type: z.literal("email").describe("Email property type"),
  email: EMPTY_OBJECT_SCHEMA.describe(
    "There is no additional property configuration."
  ),
  description: z.string().optional().describe("Property description"),
});

// 12. Phone number property
export const PHONE_NUMBER_DB_PROPERTY_SCHEMA = z.object({
  type: z.literal("phone_number").describe("Phone number property type"),
  phone_number: EMPTY_OBJECT_SCHEMA.describe(
    "There is no additional property configuration."
  ),
  description: z.string().optional().describe("Property description"),
});

// 13. Formula property
export const FORMULA_DB_PROPERTY_SCHEMA = z.object({
  type: z.literal("formula").describe("Formula property type"),
  formula: z
    .object({
      expression: z.string().describe("Formula expression"),
    })
    .describe("Formula property configuration"),
  description: z.string().optional().describe("Property description"),
});

// 14. Relation property
export const RELATION_DB_PROPERTY_SCHEMA = z.object({
  type: z.literal("relation").describe("Relation property type"),
  relation: z
    .object({
      data_source_id: z
        .string()
        .describe("The ID of the data source this relation refers to"),
      synced_property_name: z
        .string()
        .optional()
        .describe("Synced property name"),
      synced_property_id: z.string().optional().describe("Synced property ID"),
      single_property: EMPTY_OBJECT_SCHEMA.describe(
        "Whether this is a single property relation"
      ),
    })
    .describe("Relation property configuration"),
  description: z.string().optional().describe("Property description"),
});

// 15. Rollup property
export const ROLLUP_FUNCTION = z.enum([
  "average",
  "checked",
  "count_per_group",
  "count",
  "count_values",
  "date_range",
  "earliest_date",
  "empty",
  "latest_date",
  "max",
  "median",
  "min",
  "not_empty",
  "percent_checked",
  "percent_empty",
  "percent_not_empty",
  "percent_per_group",
  "percent_unchecked",
  "range",
  "show_original",
  "show_unique",
  "sum",
  "unchecked",
  "unique",
]);

export const ROLLUP_DB_PROPERTY_SCHEMA = z.object({
  type: z.literal("rollup").describe("Rollup property type"),
  rollup: z
    .object({
      relation_property_name: z
        .string()
        .describe("Name of the relation property"),
      relation_property_id: z.string().describe("ID of the relation property"),
      rollup_property_name: z
        .string()
        .describe("Name of the property to roll up"),
      rollup_property_id: z.string().describe("ID of the property to roll up"),
      function: ROLLUP_FUNCTION.describe("Rollup function"),
    })
    .describe("Rollup property configuration"),
  description: z.string().optional().describe("Property description"),
});

// 16. Created time property
export const CREATED_TIME_DB_PROPERTY_SCHEMA = z.object({
  type: z.literal("created_time").describe("Created time property type"),
  created_time: EMPTY_OBJECT_SCHEMA.describe(
    "There is no additional property configuration."
  ),
  description: z.string().optional().describe("Property description"),
});

// 17. Created by property
export const CREATED_BY_DB_PROPERTY_SCHEMA = z.object({
  type: z.literal("created_by").describe("Created by property type"),
  created_by: EMPTY_OBJECT_SCHEMA.describe(
    "There is no additional property configuration."
  ),
  description: z.string().optional().describe("Property description"),
});

// 18. Last edited time property
export const LAST_EDITED_TIME_DB_PROPERTY_SCHEMA = z.object({
  type: z
    .literal("last_edited_time")
    .describe("Last edited time property type"),
  last_edited_time: EMPTY_OBJECT_SCHEMA.describe(
    "There is no additional property configuration."
  ),
  description: z.string().optional().describe("Property description"),
});

// 19. Last edited by property
export const LAST_EDITED_BY_DB_PROPERTY_SCHEMA = z.object({
  type: z.literal("last_edited_by").describe("Last edited by property type"),
  last_edited_by: EMPTY_OBJECT_SCHEMA.describe(
    "There is no additional property configuration."
  ),
  description: z.string().optional().describe("Property description"),
});

// Status property
export const STATUS_OPTION_SCHEMA = z.object({
  id: z.string().optional().describe("ID of the status option"),
  name: z.string().describe("Name of the status option"),
  color: SELECT_COLOR_SCHEMA.describe("Color of the status option"),
});

export const STATUS_GROUP_SCHEMA = z.object({
  id: z.string().optional().describe("ID of the status group"),
  name: z.string().describe("Name of the status group"),
  color: SELECT_COLOR_SCHEMA.describe("Color of the status group"),
  option_ids: z.array(z.string()).describe("IDs of options in this group"),
});

export const STATUS_DB_PROPERTY_SCHEMA = z.object({
  type: z.literal("status").describe("Status property type"),
  status: z
    .object({
      options: z.array(STATUS_OPTION_SCHEMA).describe("Status options"),
    })
    .describe("Status property configuration"),
  description: z.string().optional().describe("Property description"),
});

export const BUTTON_DB_PROPERTY_SCHEMA = z.object({
  type: z.literal("button"),
  button: EMPTY_OBJECT_SCHEMA,
  description: z.string().optional(),
});

export const UNIQUE_ID_DB_PROPERTY_SCHEMA = z.object({
  type: z.literal("unique_id"),
  unique_id: z
    .object({
      prefix: z
        .string()
        .regex(
          /^[A-Za-z][A-Za-z0-9-]{1,9}$/,
          "prefix must start with a letter, then 1–9 more letters/digits/hyphens (total length 2–10)"
        )
        .nullable()
        .optional()
        .describe("Prefix shown before the auto-incrementing number. 2–10 chars total, must start with a letter, alphanumeric + hyphen only. Single-letter prefixes are rejected by Notion."),
    })
    .describe("Unique ID property configuration"),
  description: z.string().optional(),
});

export const VERIFICATION_DB_PROPERTY_SCHEMA = z.object({
  type: z.literal("verification"),
  verification: EMPTY_OBJECT_SCHEMA,
  description: z.string().optional(),
});

// Combined database property schema
export const DATABASE_PROPERTY_SCHEMA = z.preprocess(
  preprocessJson,
  z
    .discriminatedUnion("type", [
      TITLE_DB_PROPERTY_SCHEMA,
      RICH_TEXT_DB_PROPERTY_SCHEMA,
      NUMBER_DB_PROPERTY_SCHEMA,
      SELECT_DB_PROPERTY_SCHEMA,
      MULTI_SELECT_DB_PROPERTY_SCHEMA,
      DATE_DB_PROPERTY_SCHEMA,
      PEOPLE_DB_PROPERTY_SCHEMA,
      FILES_DB_PROPERTY_SCHEMA,
      CHECKBOX_DB_PROPERTY_SCHEMA,
      URL_DB_PROPERTY_SCHEMA,
      EMAIL_DB_PROPERTY_SCHEMA,
      PHONE_NUMBER_DB_PROPERTY_SCHEMA,
      FORMULA_DB_PROPERTY_SCHEMA,
      RELATION_DB_PROPERTY_SCHEMA,
      ROLLUP_DB_PROPERTY_SCHEMA,
      CREATED_TIME_DB_PROPERTY_SCHEMA,
      CREATED_BY_DB_PROPERTY_SCHEMA,
      LAST_EDITED_TIME_DB_PROPERTY_SCHEMA,
      LAST_EDITED_BY_DB_PROPERTY_SCHEMA,
      BUTTON_DB_PROPERTY_SCHEMA,
      UNIQUE_ID_DB_PROPERTY_SCHEMA,
      VERIFICATION_DB_PROPERTY_SCHEMA,
    ])
    .describe("Union of all possible database property types")
);


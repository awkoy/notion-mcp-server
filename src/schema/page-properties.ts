import { z } from "zod";
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
  files: z.array(
    z.object({
      name: z.string(),
      external: z.object({
        url: z.url({ protocol: /^https?$/ }),
      }),
    })
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
      id: z.string(),
    })
  ),
});

export const PHONE_NUMBER_PROPERTY_VALUE_SCHEMA = z.object({
  phone_number: z.string(),
});

export const RELATION_PROPERTY_VALUE_SCHEMA = z.object({
  relation: z.array(
    z.object({
      id: z.string(),
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

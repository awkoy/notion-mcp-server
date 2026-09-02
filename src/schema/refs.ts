import { RICH_TEXT_ITEM_REQUEST_SCHEMA } from "./rich-text.js";
import { PARENT_SCHEMA } from "./page.js";
import { ICON_SCHEMA } from "./icon.js";
import { FILE_SCHEMA } from "./file.js";
import { PROPERTY_VALUE_SCHEMA } from "./page-properties.js";
import { TEXT_RICH_TEXT_ITEM_REQUEST_SCHEMA } from "./rich-text.js";
import { ANNOTATIONS_SCHEMA } from "./annotations.js";
import { COLOR_SCHEMA } from "./color.js";
import { LANGUAGE_SCHEMA } from "./lang.js";
import { MENTION_REQUEST_SCHEMA } from "./mention.js";
import { DATABASE_PROPERTY_SCHEMA, ROLLUP_FUNCTION, SELECT_COLOR_SCHEMA } from "./database.js";
import { NUMBER_FORMAT } from "./number.js";
import { registerSharedRef } from "./emit.js";

/**
 * Canonical sub-schemas registered for $defs hoisting in emitted JSON Schemas.
 * When any operation's input mentions one of these structurally, the emitter
 * replaces the inlined copy with a $ref. This is where most schema-size wins come from.
 */
export function registerSharedSubSchemas(): void {
  registerSharedRef("rich_text_item", RICH_TEXT_ITEM_REQUEST_SCHEMA);
  registerSharedRef("parent", PARENT_SCHEMA);
  registerSharedRef("icon", ICON_SCHEMA);
  registerSharedRef("file", FILE_SCHEMA);
  registerSharedRef("property_value", PROPERTY_VALUE_SCHEMA);
  registerSharedRef("text_rich_text_item", TEXT_RICH_TEXT_ITEM_REQUEST_SCHEMA);
  registerSharedRef("annotations", ANNOTATIONS_SCHEMA);
  registerSharedRef("color", COLOR_SCHEMA);
  registerSharedRef("language", LANGUAGE_SCHEMA);
  registerSharedRef("mention", MENTION_REQUEST_SCHEMA);
  registerSharedRef("database_property", DATABASE_PROPERTY_SCHEMA);
  registerSharedRef("select_color", SELECT_COLOR_SCHEMA);
  registerSharedRef("rollup_function", ROLLUP_FUNCTION);
  registerSharedRef("number_format", NUMBER_FORMAT);
}

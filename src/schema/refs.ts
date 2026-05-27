import { RICH_TEXT_ITEM_REQUEST_SCHEMA } from "./rich-text.js";
import { PARENT_SCHEMA } from "./page.js";
import { ICON_SCHEMA } from "./icon.js";
import { FILE_SCHEMA } from "./file.js";
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
}

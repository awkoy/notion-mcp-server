import { z } from "zod";

export const EXTERNAL_FILE_SCHEMA = z.object({
  type: z.literal("external").describe("Type of file source"),
  external: z
    .object({
      url: z.url({ protocol: /^https?$/ }).describe("URL of the external file"),
    })
    .describe("External file source"),
});

export const FILE_UPLOAD_SCHEMA = z.object({
  type: z.literal("file_upload").describe("Type of file source"),
  file_upload: z
    .object({
      id: z.string().describe("file_upload_id returned by upload_file"),
    })
    .describe("A file already uploaded through upload_file"),
});

// Both members stay exported because a discriminated union has no `.shape`.
// A caller that adds a field to a file (an image block adds a caption) has to
// extend each arm.
export const FILE_SCHEMA = z
  .discriminatedUnion("type", [EXTERNAL_FILE_SCHEMA, FILE_UPLOAD_SCHEMA])
  .describe("File schema");

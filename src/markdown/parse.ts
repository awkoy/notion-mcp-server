import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type {
  Root,
  RootContent,
  Paragraph,
  Heading,
  List,
  ListItem,
  Blockquote,
  Code,
  Image,
  PhrasingContent,
  Link,
  InlineCode,
  Emphasis,
  Strong,
  Delete,
  Text,
} from "mdast";

type RichText =
  | {
      type: "text";
      text: { content: string; link?: { url: string } | null };
      annotations?: Annotations;
    }
  | {
      type: "equation";
      equation: { expression: string };
      annotations?: Annotations;
    };

type Annotations = Partial<{
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  underline: boolean;
  code: boolean;
}>;

type NotionBlock = {
  object?: "block";
  type: string;
  [key: string]: unknown;
};

const processor = unified().use(remarkParse).use(remarkGfm);

export function parseMarkdownToBlocks(markdown: string): NotionBlock[] {
  if (!markdown.trim()) return [];
  const tree = processor.parse(markdown) as Root;
  return tree.children.flatMap(convertBlock);
}

function convertBlock(node: RootContent): NotionBlock[] {
  switch (node.type) {
    case "paragraph":
      return [paragraphFrom(node)];
    case "heading":
      return [headingFrom(node)];
    case "list":
      return convertList(node);
    case "blockquote":
      return convertBlockquote(node);
    case "code":
      return [codeFrom(node)];
    case "thematicBreak":
      return [{ type: "divider", divider: {} }];
    default:
      return [];
  }
}

function paragraphFrom(node: Paragraph): NotionBlock {
  if (node.children.length === 1 && node.children[0].type === "image") {
    return imageFrom(node.children[0]);
  }
  const inlineImage = node.children.find((c) => c.type === "image") as Image | undefined;
  if (inlineImage && node.children.length === 1) {
    return imageFrom(inlineImage);
  }
  return {
    type: "paragraph",
    paragraph: { rich_text: phrasingToRichText(node.children) },
  };
}

function headingFrom(node: Heading): NotionBlock {
  const level = Math.min(4, node.depth) as 1 | 2 | 3 | 4;
  const key = `heading_${level}` as const;
  return {
    type: key,
    [key]: { rich_text: phrasingToRichText(node.children) },
  };
}

function convertList(node: List): NotionBlock[] {
  const isOrdered = node.ordered === true;
  const type = isOrdered ? "numbered_list_item" : "bulleted_list_item";
  return node.children.map((item) => listItemBlock(item, type));
}

function listItemBlock(
  item: ListItem,
  defaultType: "numbered_list_item" | "bulleted_list_item"
): NotionBlock {
  const isToDo = typeof item.checked === "boolean";
  const firstParaIdx = item.children.findIndex((c) => c.type === "paragraph");
  const head =
    firstParaIdx >= 0
      ? (item.children[firstParaIdx] as Paragraph)
      : ({ type: "paragraph", children: [] } as Paragraph);
  const richText = phrasingToRichText(head.children);
  const tail = item.children.filter((_, i) => i !== firstParaIdx);
  const children = tail.flatMap(convertBlock);

  if (isToDo) {
    return {
      type: "to_do",
      to_do: {
        rich_text: richText,
        checked: item.checked === true,
        ...(children.length ? { children } : {}),
      },
    };
  }

  return {
    type: defaultType,
    [defaultType]: {
      rich_text: richText,
      ...(children.length ? { children } : {}),
    },
  };
}

function convertBlockquote(node: Blockquote): NotionBlock[] {
  const children = node.children.flatMap(convertBlock);
  if (children.length === 0) return [];
  const [first, ...rest] = children;
  if (first.type === "paragraph") {
    const paragraph = first.paragraph as { rich_text: RichText[] };
    return [
      {
        type: "quote",
        quote: {
          rich_text: paragraph.rich_text,
          ...(rest.length ? { children: rest } : {}),
        },
      },
    ];
  }
  return [
    {
      type: "quote",
      quote: { rich_text: [], children },
    },
  ];
}

function codeFrom(node: Code): NotionBlock {
  return {
    type: "code",
    code: {
      rich_text: [
        {
          type: "text" as const,
          text: { content: node.value },
        },
      ],
      language: normalizeLanguage(node.lang),
    },
  };
}

function imageFrom(node: Image): NotionBlock {
  return {
    type: "image",
    image: {
      type: "external",
      external: { url: node.url },
      ...(node.alt
        ? {
            caption: [
              { type: "text" as const, text: { content: node.alt } },
            ],
          }
        : {}),
    },
  };
}

function phrasingToRichText(
  nodes: PhrasingContent[],
  annotations: Annotations = {}
): RichText[] {
  const out: RichText[] = [];
  for (const node of nodes) {
    pushPhrasing(node, annotations, out);
  }
  return mergeAdjacent(out);
}

function pushPhrasing(
  node: PhrasingContent,
  annotations: Annotations,
  out: RichText[]
): void {
  switch (node.type) {
    case "text":
      out.push(textRT((node as Text).value, annotations));
      return;
    case "strong":
      for (const c of (node as Strong).children) {
        pushPhrasing(c, { ...annotations, bold: true }, out);
      }
      return;
    case "emphasis":
      for (const c of (node as Emphasis).children) {
        pushPhrasing(c, { ...annotations, italic: true }, out);
      }
      return;
    case "delete":
      for (const c of (node as Delete).children) {
        pushPhrasing(c, { ...annotations, strikethrough: true }, out);
      }
      return;
    case "inlineCode":
      out.push(textRT((node as InlineCode).value, { ...annotations, code: true }));
      return;
    case "link": {
      const link = node as Link;
      const inner: RichText[] = [];
      for (const c of link.children) pushPhrasing(c, annotations, inner);
      const merged = mergeAdjacent(inner);
      for (const r of merged) {
        if (r.type === "text") r.text.link = { url: link.url };
        out.push(r);
      }
      return;
    }
    case "break":
      out.push(textRT("\n", annotations));
      return;
    default:
      // Unhandled inline (image inside paragraph already promoted; html, footnote, etc.)
      return;
  }
}

function textRT(content: string, annotations: Annotations): RichText {
  const cleaned = clean(annotations);
  return {
    type: "text",
    text: { content },
    ...(Object.keys(cleaned).length ? { annotations: cleaned } : {}),
  };
}

function clean(a: Annotations): Annotations {
  const out: Annotations = {};
  if (a.bold) out.bold = true;
  if (a.italic) out.italic = true;
  if (a.strikethrough) out.strikethrough = true;
  if (a.underline) out.underline = true;
  if (a.code) out.code = true;
  return out;
}

function mergeAdjacent(items: RichText[]): RichText[] {
  const out: RichText[] = [];
  for (const item of items) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.type === "text" &&
      item.type === "text" &&
      sameAnnotations(prev.annotations, item.annotations) &&
      sameLink(prev.text.link, item.text.link)
    ) {
      prev.text.content += item.text.content;
      continue;
    }
    out.push(item);
  }
  return out;
}

function sameAnnotations(a?: Annotations, b?: Annotations): boolean {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

function sameLink(a?: { url: string } | null, b?: { url: string } | null): boolean {
  return (a?.url ?? null) === (b?.url ?? null);
}

const KNOWN_LANGUAGES = new Set([
  "abap", "arduino", "bash", "basic", "c", "clojure", "coffeescript", "c++",
  "c#", "css", "dart", "diff", "docker", "elixir", "elm", "erlang", "flow",
  "fortran", "f#", "gherkin", "glsl", "go", "graphql", "groovy", "haskell",
  "html", "java", "javascript", "json", "julia", "kotlin", "latex", "less",
  "lisp", "livescript", "lua", "makefile", "markdown", "markup", "matlab",
  "mermaid", "nix", "objective-c", "ocaml", "pascal", "perl", "php", "plain text",
  "powershell", "prolog", "protobuf", "python", "r", "reason", "ruby", "rust",
  "sass", "scala", "scheme", "scss", "shell", "sql", "swift", "typescript",
  "vb.net", "verilog", "vhdl", "visual basic", "webassembly", "xml", "yaml",
]);

function normalizeLanguage(lang: string | null | undefined): string {
  if (!lang) return "plain text";
  const lower = lang.toLowerCase();
  if (KNOWN_LANGUAGES.has(lower)) return lower;
  const aliases: Record<string, string> = {
    js: "javascript",
    ts: "typescript",
    py: "python",
    rb: "ruby",
    sh: "shell",
    yml: "yaml",
    md: "markdown",
    "c++": "c++",
    cpp: "c++",
    cs: "c#",
    "objc": "objective-c",
    rs: "rust",
    tsx: "typescript",
    jsx: "javascript",
  };
  return aliases[lower] ?? "plain text";
}

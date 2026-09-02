import { describe, it, expect } from "vitest";
import { compileWhere } from "../src/schema/filter-dsl.js";

// Acceptance tests for the typed filter DSL. The brief mandates four
// translations; the rest exercise edge cases that the four cases share —
// type inference, multi-op AND, in/notIn fan-out, and NOT via De Morgan.

describe("compileWhere — bare scalar shorthand", () => {
  it("translates {Status: 'Done'} to a select.equals leaf", () => {
    expect(compileWhere({ Status: "Done" })).toEqual({
      property: "Status",
      select: { equals: "Done" },
    });
  });

  it("translates a bare number to number.equals", () => {
    expect(compileWhere({ Count: 5 })).toEqual({
      property: "Count",
      number: { equals: 5 },
    });
  });

  it("translates a bare boolean to checkbox.equals", () => {
    expect(compileWhere({ Done: true })).toEqual({
      property: "Done",
      checkbox: { equals: true },
    });
  });

  it("treats an ISO-date string as a date.equals", () => {
    expect(compileWhere({ Due: "2026-01-01" })).toEqual({
      property: "Due",
      date: { equals: "2026-01-01" },
    });
  });

  it("treats null as is_empty (default rich_text)", () => {
    expect(compileWhere({ Notes: null })).toEqual({
      property: "Notes",
      rich_text: { is_empty: true },
    });
  });
});

describe("compileWhere — operator objects", () => {
  it("translates {Priority: {gte: 3}} to number.greater_than_or_equal_to", () => {
    expect(compileWhere({ Priority: { gte: 3 } })).toEqual({
      property: "Priority",
      number: { greater_than_or_equal_to: 3 },
    });
  });

  it("translates date {Due: {before: ...}} to date.before", () => {
    expect(compileWhere({ Due: { before: "2026-01-01" } })).toEqual({
      property: "Due",
      date: { before: "2026-01-01" },
    });
  });

  it("infers rich_text from text-only operators", () => {
    expect(compileWhere({ Notes: { contains: "draft" } })).toEqual({
      property: "Notes",
      rich_text: { contains: "draft" },
    });
  });

  it("honours __type override even when value shape suggests another type", () => {
    expect(compileWhere({ Tags: { eq: "x", __type: "multi_select" } })).toEqual({
      property: "Tags",
      multi_select: { contains: "x" },
    });
  });

  it("expands {in: [...]} to OR of equals", () => {
    expect(compileWhere({ Status: { in: ["Open", "Done"] } })).toEqual({
      or: [
        { property: "Status", select: { equals: "Open" } },
        { property: "Status", select: { equals: "Done" } },
      ],
    });
  });

  it("expands {notIn: [...]} to AND of does_not_equal", () => {
    expect(compileWhere({ Status: { notIn: ["Wontfix"] } })).toEqual({
      and: [{ property: "Status", select: { does_not_equal: "Wontfix" } }],
    });
  });

  it("ANDs multiple operators on the same property", () => {
    expect(compileWhere({ Count: { gte: 1, lte: 10 } })).toEqual({
      and: [
        { property: "Count", number: { greater_than_or_equal_to: 1 } },
        { property: "Count", number: { less_than_or_equal_to: 10 } },
      ],
    });
  });
});

describe("compileWhere — logical composition", () => {
  it("composes {AND: [...]} of two property clauses", () => {
    expect(
      compileWhere({
        AND: [{ Status: "Done" }, { Priority: { gte: 3 } }],
      })
    ).toEqual({
      and: [
        { property: "Status", select: { equals: "Done" } },
        { property: "Priority", number: { greater_than_or_equal_to: 3 } },
      ],
    });
  });

  it("composes {OR: [...]} and flattens single-element compounds", () => {
    expect(compileWhere({ OR: [{ Status: "Done" }] })).toEqual({
      property: "Status",
      select: { equals: "Done" },
    });
  });

  it("treats top-level multi-key clauses as implicit AND", () => {
    expect(
      compileWhere({ Status: "Done", Priority: { gte: 3 } })
    ).toEqual({
      and: [
        { property: "Status", select: { equals: "Done" } },
        { property: "Priority", number: { greater_than_or_equal_to: 3 } },
      ],
    });
  });

  it("negates a leaf via NOT", () => {
    expect(compileWhere({ NOT: { Status: "Done" } })).toEqual({
      property: "Status",
      select: { does_not_equal: "Done" },
    });
  });

  it("applies De Morgan when negating a compound", () => {
    expect(
      compileWhere({ NOT: { AND: [{ Status: "Done" }, { Priority: { gte: 3 } }] } })
    ).toEqual({
      or: [
        { property: "Status", select: { does_not_equal: "Done" } },
        { property: "Priority", number: { less_than: 3 } },
      ],
    });
  });

  it("accepts lowercase and/or/not as combinator keywords", () => {
    expect(compileWhere({ and: [{ Status: "Done" }, { Done: true }] })).toEqual({
      and: [
        { property: "Status", select: { equals: "Done" } },
        { property: "Done", checkbox: { equals: true } },
      ],
    });
    expect(compileWhere({ or: [{ Status: "Open" }, { Status: "Done" }] })).toEqual({
      or: [
        { property: "Status", select: { equals: "Open" } },
        { property: "Status", select: { equals: "Done" } },
      ],
    });
    expect(compileWhere({ not: { Status: "Done" } })).toEqual({
      property: "Status",
      select: { does_not_equal: "Done" },
    });
  });
});

describe("compileWhere — empty + invalid input", () => {
  it("returns undefined for empty object", () => {
    expect(compileWhere({})).toBeUndefined();
  });

  it("returns undefined for null / undefined", () => {
    expect(compileWhere(null)).toBeUndefined();
    expect(compileWhere(undefined)).toBeUndefined();
  });

  it("throws on unsupported operator for pinned type", () => {
    expect(() =>
      compileWhere({ Priority: { __type: "number", contains: "foo" } })
    ).toThrow(/Unsupported operator "contains"/);
  });

  it("throws on empty in[]", () => {
    expect(() => compileWhere({ Status: { in: [] } })).toThrow(/"in".*non-empty/);
  });
});

describe("compileWhere — with the data source's property types", () => {
  const types = {
    Name: { type: "title" },
    Status: { type: "status" },
    Kind: { type: "select" },
    Done: { type: "checkbox" },
    Due: { type: "date" },
    Notes: { type: "rich_text" },
    Total: { type: "formula" },
  };

  it("uses the declared type instead of guessing from the value", () => {
    expect(compileWhere({ Status: "Done" }, types)).toEqual({
      property: "Status",
      status: { equals: "Done" },
    });
    expect(compileWhere({ Name: "Report" }, types)).toEqual({
      property: "Name",
      title: { equals: "Report" },
    });
    expect(compileWhere({ Notes: { contains: "x" } }, types)).toEqual({
      property: "Notes",
      rich_text: { contains: "x" },
    });
  });

  it("compiles null against the declared type", () => {
    expect(compileWhere({ Due: null }, types)).toEqual({ property: "Due", date: { is_empty: true } });
    expect(compileWhere({ Done: null }, types)).toEqual({ property: "Done", checkbox: { equals: false } });
  });

  it("rejects a property the data source does not have, listing the valid names", () => {
    expect(() => compileWhere({ Priority: "High" }, types)).toThrow(
      /Unknown property "Priority"\. The data source has: Name, Status, Kind, Done, Due, Notes, Total/
    );
  });

  it("falls back to inference for types the DSL has no operators for, and lets __type win", () => {
    expect(compileWhere({ Total: { gte: 3 } }, types)).toEqual({ property: "Total", number: { greater_than_or_equal_to: 3 } });
    expect(compileWhere({ Kind: { __type: "rich_text", contains: "a" } }, types)).toEqual({
      property: "Kind",
      rich_text: { contains: "a" },
    });
  });

  it("threads the types through AND / OR / NOT", () => {
    expect(compileWhere({ or: [{ Status: "Done" }, { not: { Kind: "Bug" } }] }, types)).toEqual({
      or: [
        { property: "Status", status: { equals: "Done" } },
        { property: "Kind", select: { does_not_equal: "Bug" } },
      ],
    });
  });
});

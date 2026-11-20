import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initOperations } from "../src/operations/index.js";
import { dispatch } from "../src/dispatch/index.js";

const stub = {
  dataSources: { retrieve: vi.fn() },
  databases: { retrieve: vi.fn() },
  views: {
    retrieve: vi.fn(),
    create: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
  },
};

vi.mock("../src/services/notion.js", () => ({ getClient: async () => stub }));

beforeAll(async () => {
  await initOperations();
});

beforeEach(() => {
  for (const group of Object.values(stub)) {
    for (const fn of Object.values(group)) fn.mockReset();
  }
});

const dashboard = (counts: number[] = []) => ({
  object: "view",
  id: "dash-1",
  type: "dashboard",
  configuration: {
    type: "dashboard",
    rows: counts.map((n) => ({
      widgets: Array.from({ length: n }, (_, i) => ({ view_id: "w-" + i })),
    })),
  },
});

const widget = {
  view_id: "dash-1",
  data_source_id: "source-1",
  name: "Open Items",
  type: "table",
};

describe("create_view Dashboard widgets", () => {
  it("creates a widget using view_id and placement, not database_id", async () => {
    stub.views.retrieve.mockResolvedValue(dashboard([1]));
    stub.views.create.mockResolvedValue({
      id: "widget-1", name: "Open Items", type: "table", dashboard_view_id: "dash-1",
    });
    const result = await dispatch("create_view", {
      ...widget,
      placement: { type: "existing_row", row_index: 0 },
      where: { Status: "Open" },
    });
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({
      data: { id: "widget-1", dashboard_view_id: "dash-1" },
    });
    expect(stub.views.create).toHaveBeenCalledWith(expect.objectContaining({
      view_id: "dash-1",
      data_source_id: "source-1",
      placement: { type: "existing_row", row_index: 0 },
    }));
    expect(stub.views.create.mock.calls[0][0]).not.toHaveProperty("database_id");
  });

  it("rejects ambiguous, invalid, or unsafe targets before creation", async () => {
    const bad = [
      { ...widget, database_id: "db-1" },
      { view_id: "dash-1", name: "X", type: "table" },
      { ...widget, type: "dashboard" },
      { data_source_id: "source-1", name: "X", type: "table", placement: { type: "new_row" } },
    ];
    for (const params of bad) {
      const res = await dispatch("create_view", params);
      expect(res.ok).toBe(false);
    }
    expect(stub.views.create).not.toHaveBeenCalled();
    expect(stub.views.retrieve).not.toHaveBeenCalled();
  });

  it("rejects a non-Dashboard target", async () => {
    stub.views.retrieve.mockResolvedValue({ object: "view", id: "dash-1", type: "table" });
    const result = await dispatch("create_view", widget);
    expect(result).toMatchObject({ ok: false, error: { code: "not_dashboard" } });
    expect(stub.views.create).not.toHaveBeenCalled();
  });

  it("fails closed if the Dashboard layout cannot be inspected", async () => {
    stub.views.retrieve.mockResolvedValue({ object: "view", id: "dash-1", type: "dashboard" });
    const result = await dispatch("create_view", widget);
    expect(result).toMatchObject({
      ok: false, error: { code: "dashboard_layout_unavailable" },
    });
    expect(stub.views.create).not.toHaveBeenCalled();
  });

  it("checks row indices and the four-widget row limit", async () => {
    stub.views.retrieve.mockResolvedValue(dashboard([4, 1]));
    let result = await dispatch("create_view", {
      ...widget, placement: { type: "existing_row", row_index: 0 },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "dashboard_row_full" } });
    result = await dispatch("create_view", {
      ...widget, placement: { type: "existing_row", row_index: 2 },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_dashboard_row" } });
    result = await dispatch("create_view", {
      ...widget, placement: { type: "new_row", row_index: 3 },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_dashboard_row" } });
    expect(stub.views.create).not.toHaveBeenCalled();
  });

  it("checks the 12-widget Dashboard limit", async () => {
    stub.views.retrieve.mockResolvedValue(dashboard([4, 4, 4]));
    const result = await dispatch("create_view", widget);
    expect(result).toMatchObject({ ok: false, error: { code: "dashboard_full" } });
    expect(stub.views.create).not.toHaveBeenCalled();
  });

  it("allows a new row when the Dashboard has capacity", async () => {
    stub.views.retrieve.mockResolvedValue(dashboard([4]));
    stub.views.create.mockResolvedValue({
      id: "v", name: "Open Items", type: "list", dashboard_view_id: "dash-1",
    });
    const result = await dispatch("create_view", {
      ...widget, type: "list", placement: { type: "new_row", row_index: 1 },
    });
    expect(result.ok).toBe(true);
    expect(stub.views.create).toHaveBeenCalledWith(expect.objectContaining({
      placement: { type: "new_row", row_index: 1 },
    }));
  });
});

describe("ensure_dashboard_widget", () => {
  const request = { ...widget, dry_run: false };

  it("reuses an exact widget without creating a duplicate", async () => {
    const existing = {
      id: "w-1",
      name: "Open Items",
      type: "table",
      data_source_id: "source-1",
      filter: null,
      dashboard_view_id: "dash-1",
    };
    stub.views.retrieve.mockImplementation(async ({ view_id }) =>
      view_id === "dash-1"
        ? { ...dashboard(), configuration: { rows: [{ widgets: [{ view_id: "w-1" }] }] } }
        : existing
    );
    const result = await dispatch("ensure_dashboard_widget", request);
    expect(result).toMatchObject({
      ok: true,
      data: { action: "existing", verified: true, widget: { id: "w-1" } },
    });
    expect(stub.views.create).not.toHaveBeenCalled();
  });

  it("equates requested property names with saved encoded property IDs", async () => {
    stub.dataSources.retrieve.mockResolvedValue({
      id: "source-1",
      properties: { Status: { id: "%3DV%5BM", type: "select" } },
    });
    stub.views.retrieve.mockImplementation(async ({ view_id }) =>
      view_id === "dash-1"
        ? { ...dashboard(), configuration: { rows: [{ widgets: [{ view_id: "w-1" }] }] } }
        : {
            id: "w-1",
            name: "Open Items",
            type: "table",
            data_source_id: "source-1",
            dashboard_view_id: "dash-1",
            filter: { property: "=V[M", select: { equals: "Open" } },
          }
    );
    const result = await dispatch("ensure_dashboard_widget", {
      ...request,
      filter: { property: "Status", select: { equals: "Open" } },
    });
    expect(result).toMatchObject({
      ok: true, data: { action: "existing", widget: { id: "w-1" } },
    });
    expect(stub.dataSources.retrieve).toHaveBeenCalledWith({
      data_source_id: "source-1",
    });
    expect(stub.views.create).not.toHaveBeenCalled();
  });

  it("holds a same-name widget with mismatched source", async () => {
    stub.views.retrieve.mockImplementation(async ({ view_id }) =>
      view_id === "dash-1"
        ? { ...dashboard(), configuration: { rows: [{ widgets: [{ view_id: "w-2" }] }] } }
        : {
            id: "w-2",
            name: "Open Items",
            type: "table",
            data_source_id: "other-source",
            filter: null,
          }
    );
    const result = await dispatch("ensure_dashboard_widget", request);
    expect(result).toMatchObject({
      ok: false, error: { code: "dashboard_widget_conflict" },
    });
    expect(stub.views.create).not.toHaveBeenCalled();
  });

  it("holds a same-name widget with a different saved filter", async () => {
    stub.dataSources.retrieve.mockResolvedValue({
      id: "source-1",
      properties: { Status: { id: "%3DV%5BM", type: "select" } },
    });
    stub.views.retrieve.mockImplementation(async ({ view_id }) =>
      view_id === "dash-1"
        ? { ...dashboard(), configuration: { rows: [{ widgets: [{ view_id: "w-1" }] }] } }
        : {
            id: "w-1",
            name: "Open Items",
            type: "table",
            data_source_id: "source-1",
            filter: { property: "=V[M", select: { equals: "Closed" } },
          }
    );
    const result = await dispatch("ensure_dashboard_widget", {
      ...request,
      filter: { property: "Status", select: { equals: "Open" } },
    });
    expect(result).toMatchObject({
      ok: false, error: { code: "dashboard_widget_conflict" },
    });
    expect(stub.views.create).not.toHaveBeenCalled();
  });

  it("supports dry-run without writing a widget", async () => {
    stub.views.retrieve.mockResolvedValue(dashboard([1]));
    const result = await dispatch("ensure_dashboard_widget", {
      ...request, dry_run: true,
    });
    expect(result).toMatchObject({
      ok: true, data: { action: "would_create", dashboard_view_id: "dash-1" },
    });
    expect(stub.views.create).not.toHaveBeenCalled();
  });

  it("creates once and verifies Dashboard membership", async () => {
    let dashboardReads = 0;
    stub.views.retrieve.mockImplementation(async ({ view_id }) => {
      if (view_id !== "dash-1") {
        return {
          id: "new-widget",
          name: "Open Items",
          type: "table",
          data_source_id: "source-1",
          dashboard_view_id: "dash-1",
        };
      }
      dashboardReads++;
      return dashboardReads === 1
        ? dashboard([])
        : {
            ...dashboard(),
            configuration: { rows: [{ widgets: [{ view_id: "new-widget" }] }] },
          };
    });
    stub.views.create.mockResolvedValue({
      id: "new-widget", name: "Open Items", type: "table", dashboard_view_id: "dash-1",
    });
    const result = await dispatch("ensure_dashboard_widget", request);
    expect(result).toMatchObject({
      ok: true, data: { action: "created", verified: true },
    });
    expect(stub.views.create).toHaveBeenCalledTimes(1);
  });

  it("preserves the created ID when immediate readback is unavailable", async () => {
    stub.views.retrieve.mockResolvedValueOnce(dashboard([]))
      .mockRejectedValue(new Error("temporarily unavailable"));
    stub.views.create.mockResolvedValue({
      id: "new-widget", name: "Open Items", type: "table",
    });
    const result = await dispatch("ensure_dashboard_widget", request);
    expect(result).toMatchObject({
      ok: true,
      data: {
        action: "created", verified: false, verification_required: true,
        widget: { id: "new-widget" },
      },
    });
  });
});

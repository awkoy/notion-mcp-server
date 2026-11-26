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
    stub.dataSources.retrieve.mockResolvedValue({
      id: "source-1", properties: { Status: { id: "status-id", type: "status" } },
    });
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
    expect(stub.views.create.mock.calls[0][0]).toMatchObject({
      filter: { property: "Status", status: { equals: "Open" } },
    });
    expect(stub.dataSources.retrieve).toHaveBeenCalledExactlyOnceWith({ data_source_id: "source-1" });
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

  it("serializes Dashboard capacity checks across concurrent creations", async () => {
    let signalEntered!: () => void;
    let releaseCreate!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const gate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    let filled = false;
    stub.views.retrieve.mockImplementation(async () => dashboard([4, 4, filled ? 4 : 3]));
    stub.views.create.mockImplementation(async () => {
      signalEntered();
      await gate;
      filled = true;
      return { id: "last-slot", type: "table", name: "Open Items" };
    });

    const first = dispatch("create_view", widget);
    await entered;
    const second = dispatch("create_view", { ...widget, name: "Another Item" });
    await Promise.resolve();
    expect(stub.views.create).toHaveBeenCalledTimes(1);
    releaseCreate();
    const [one, two] = await Promise.all([first, second]);
    expect(one.ok).toBe(true);
    expect(two).toMatchObject({ ok: false, error: { code: "dashboard_full" } });
    expect(stub.views.create).toHaveBeenCalledTimes(1);
  });

  it("compiles unhinted Dashboard where using its declared status type", async () => {
    stub.views.retrieve.mockResolvedValue(dashboard([]));
    stub.dataSources.retrieve.mockResolvedValue({
      id: "source-1",
      properties: { Status: { id: "%3DV%5BM", type: "status" } },
    });
    stub.views.create.mockResolvedValue({
      id: "status-widget", name: "Open Items", type: "table", dashboard_view_id: "dash-1",
    });
    const result = await dispatch("create_view", { ...widget, where: { Status: "Open" } });
    expect(result.ok).toBe(true);
    expect(stub.views.create).toHaveBeenCalledWith(expect.objectContaining({
      filter: { property: "Status", status: { equals: "Open" } },
    }));
  });

  it("fails closed on an unavailable property schema for typed creation", async () => {
    stub.views.retrieve.mockResolvedValue(dashboard([]));
    stub.dataSources.retrieve.mockResolvedValue({ id: "source-1" });
    const result = await dispatch("create_view", { ...widget, where: { Status: "Open" } });
    expect(result).toMatchObject({
      ok: false, error: { code: "view_filter_schema_unavailable" },
    });
    expect(stub.views.create).not.toHaveBeenCalled();
    expect(stub.dataSources.retrieve).toHaveBeenCalledExactlyOnceWith({ data_source_id: "source-1" });
  });

  it("preserves raw null and rejects where combined with raw null", async () => {
    stub.views.retrieve.mockResolvedValue(dashboard([]));
    stub.views.create.mockResolvedValue({ id: "raw-null", type: "table", name: "Open Items" });
    const raw = await dispatch("create_view", { ...widget, filter: null });
    expect(raw.ok).toBe(true);
    expect(stub.views.create).toHaveBeenCalledWith(expect.objectContaining({ filter: null }));
    expect(stub.dataSources.retrieve).not.toHaveBeenCalled();
    stub.views.create.mockClear();
    const both = await dispatch("create_view", {
      ...widget, where: { Status: "Open" }, filter: null,
    });
    expect(both).toMatchObject({ ok: false, error: { code: "filter_conflict" } });
    expect(stub.views.create).not.toHaveBeenCalled();
  });

  it("compiles a compound AND with status and number using the schema", async () => {
    stub.views.retrieve.mockResolvedValue(dashboard([]));
    stub.dataSources.retrieve.mockResolvedValue({
      id: "source-1", properties: {
        Status: { id: "id-status", type: "status" },
        Count: { id: "id-count", type: "number" },
      },
    });
    stub.views.create.mockResolvedValue({ id: "compound-view", name: "Open Items", type: "table" });
    const result = await dispatch("create_view", {
      ...widget, where: { AND: [{ Status: "Open" }, { Count: { gte: 2 } }] },
    });
    expect(result.ok).toBe(true);
    expect(stub.views.create).toHaveBeenCalledWith(expect.objectContaining({
      filter: { and: [
        { property: "Status", status: { equals: "Open" } },
        { property: "Count", number: { greater_than_or_equal_to: 2 } },
      ] },
    }));
    expect(stub.dataSources.retrieve).toHaveBeenCalledExactlyOnceWith({ data_source_id: "source-1" });
  });

  it("compiles nested OR/NOT status filters with the declared schema type", async () => {
    stub.views.retrieve.mockResolvedValue(dashboard([]));
    stub.dataSources.retrieve.mockResolvedValue({
      id: "source-1", properties: {
        Status: { id: "status-id", type: "status" },
        Count: { id: "count-id", type: "number" },
      },
    });
    stub.views.create.mockResolvedValue({ id: "v-nested", name: "Open Items", type: "table" });
    const result = await dispatch("create_view", {
      ...widget, where: { OR: [{ NOT: { Status: "Open" } }, { Count: { gt: 5 } }] },
    });
    expect(result.ok).toBe(true);
    expect(stub.views.create).toHaveBeenCalledWith(expect.objectContaining({
      filter: { or: [
        { property: "Status", status: { does_not_equal: "Open" } },
        { property: "Count", number: { greater_than: 5 } },
      ] },
    }));
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

  it("reuses status widgets for equivalent hinted and unhinted where", async () => {
    stub.dataSources.retrieve.mockResolvedValue({
      id: "source-1",
      properties: { Status: { id: "%3DV%5BM", type: "status" } },
    });
    stub.views.retrieve.mockImplementation(async ({ view_id }) =>
      view_id === "dash-1"
        ? { ...dashboard(), configuration: { rows: [{ widgets: [{ view_id: "w-1" }] }] } }
        : {
            id: "w-1", name: "Open Items", type: "table",
            data_source_id: "source-1",
            filter: { property: "=V[M", status: { equals: "Open" } },
          }
    );
    for (const where of [
      { Status: "Open" },
      { Status: { eq: "Open", __type: "status" } },
    ]) {
      const result = await dispatch("ensure_dashboard_widget", { ...request, where });
      expect(result).toMatchObject({
        ok: true, data: { action: "existing", verified: true, widget: { id: "w-1" } },
      });
    }
    const different = await dispatch("ensure_dashboard_widget", {
      ...request, where: { Status: "Closed" },
    });
    expect(different).toMatchObject({
      ok: false, error: { code: "dashboard_widget_conflict" },
    });
    expect(stub.dataSources.retrieve).toHaveBeenCalledWith({ data_source_id: "source-1" });
    expect(stub.views.create).not.toHaveBeenCalled();
  });

  it("fails closed for unhinted ensure when the data-source schema is empty", async () => {
    stub.views.retrieve.mockResolvedValue(dashboard([]));
    stub.dataSources.retrieve.mockResolvedValue({ id: "source-1", properties: {} });
    const result = await dispatch("ensure_dashboard_widget", {
      ...request, where: { Status: "Open" },
    });
    expect(result).toMatchObject({
      ok: false, error: { code: "view_filter_schema_unavailable" },
    });
    expect(stub.views.create).not.toHaveBeenCalled();
  });

  it("preserves unknown-property errors rather than false widget conflict", async () => {
    stub.views.retrieve.mockImplementation(async ({ view_id }) =>
      view_id === "dash-1"
        ? { ...dashboard(), configuration: { rows: [{ widgets: [{ view_id: "w-1" }] }] } }
        : {
            id: "w-1", name: "Open Items", type: "table",
            data_source_id: "source-1",
            filter: { property: "known", status: { equals: "Open" } },
          }
    );
    stub.dataSources.retrieve.mockResolvedValue({
      id: "source-1", properties: { Known: { id: "known", type: "status" } },
    });
    const result = await dispatch("ensure_dashboard_widget", {
      ...request, where: { NotAProperty: "Open" },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "where_compile_error" } });
    expect(stub.views.create).not.toHaveBeenCalled();
  });

  it("rejects same-name wrong type and duplicate widgets without schema reads", async () => {
    stub.views.retrieve.mockImplementation(async ({ view_id }) =>
      view_id === "dash-1"
        ? { ...dashboard(), configuration: { rows: [{ widgets: [{ view_id: "w-1" }] }] } }
        : { id: "w-1", name: "Open Items", type: "list", data_source_id: "source-1" }
    );
    const wrongType = await dispatch("ensure_dashboard_widget", {
      ...request, where: { Status: "Open" },
    });
    expect(wrongType).toMatchObject({ ok: false, error: { code: "dashboard_widget_conflict" } });
    expect(stub.dataSources.retrieve).not.toHaveBeenCalled();
    stub.views.retrieve.mockImplementation(async ({ view_id }) =>
      view_id === "dash-1"
        ? { ...dashboard(), configuration: { rows: [{ widgets: [{ view_id: "w-1" }, { view_id: "w-2" }] }] } }
        : { id: view_id, name: "Open Items", type: "table", data_source_id: "source-1" }
    );
    const duplicated = await dispatch("ensure_dashboard_widget", {
      ...request, where: { Status: "Open" },
    });
    expect(duplicated).toMatchObject({ ok: false, error: { code: "dashboard_widget_conflict" } });
    expect(stub.dataSources.retrieve).not.toHaveBeenCalled();
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
    const result = await dispatch("ensure_dashboard_widget", {
      ...request, where: { Status: "Open" },
    });
    expect(result).toMatchObject({
      ok: false, error: { code: "dashboard_widget_conflict" },
    });
    expect(stub.views.create).not.toHaveBeenCalled();
    expect(stub.dataSources.retrieve).not.toHaveBeenCalled();
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

  it("serializes simultaneous ensures without creating duplicate widgets", async () => {
    let releaseCreate!: () => void;
    let signalEntered!: () => void;
    const gate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    let visible = false;
    const created = {
      id: "serial-widget", name: "Open Items", type: "table",
      data_source_id: "source-1", dashboard_view_id: "dash-1", filter: null,
    };
    stub.views.retrieve.mockImplementation(async ({ view_id }) =>
      view_id === "dash-1"
        ? visible
          ? { ...dashboard(), configuration: { rows: [{ widgets: [{ view_id: created.id }] }] } }
          : dashboard([])
        : created
    );
    stub.views.create.mockImplementation(async () => {
      signalEntered();
      await gate;
      visible = true;
      return created;
    });

    const first = dispatch("ensure_dashboard_widget", request);
    await entered;
    const second = dispatch("ensure_dashboard_widget", request);
    await Promise.resolve();
    expect(stub.views.create).toHaveBeenCalledTimes(1);
    releaseCreate();
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.ok)).toEqual([true, true]);
    expect(results[0]).toMatchObject({ data: { action: "created" } });
    expect(results[1]).toMatchObject({ data: { action: "existing" } });
    expect(stub.views.create).toHaveBeenCalledTimes(1);
  });

  it("holds an unverified creation rather than blindly creating again", async () => {
    const pendingRequest = { ...request, view_id: "dash-pending" };
    stub.views.retrieve.mockResolvedValue({ ...dashboard([]), id: "dash-pending" });
    stub.views.create.mockResolvedValue({
      id: "pending-widget", name: "Open Items",
      type: "table", dashboard_view_id: "dash-pending",
    });
    const first = await dispatch("ensure_dashboard_widget", pendingRequest);
    expect(first).toMatchObject({
      ok: true, data: { action: "created", verified: false, verification_required: true },
    });
    // A different unhinted where must not defeat an outstanding uncertain
    // membership write by attempting schema resolution or another create.
    const second = await dispatch("ensure_dashboard_widget", {
      ...pendingRequest, where: { Status: "Open" },
    });
    expect(second).toMatchObject({
      ok: false, error: { code: "dashboard_widget_verification_pending" },
    });
    expect(stub.dataSources.retrieve).not.toHaveBeenCalled();
    stub.views.retrieve.mockImplementation(async ({ view_id }) =>
      view_id === "dash-pending"
        ? { ...dashboard(), id: "dash-pending",
            configuration: { rows: [{ widgets: [{ view_id: "pending-widget" }] }] } }
        : { id: "pending-widget", name: "Open Items", type: "table",
            data_source_id: "source-1", filter: null, dashboard_view_id: "dash-pending" }
    );
    const third = await dispatch("ensure_dashboard_widget", pendingRequest);
    expect(third).toMatchObject({ ok: true, data: { action: "existing" } });
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

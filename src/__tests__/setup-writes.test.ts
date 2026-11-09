/**
 * Tests for the board item and subtype write tools.
 *
 * Writes run against a mock of ConnectWise only. The mock holds records in a
 * store, answers a PATCH by applying the replace operations to the stored
 * record, and records every request so a test can show what was sent and that
 * nothing was sent when confirm was missing.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../worker.js";

const headers = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
  "X-CW-Company-Id": "acme",
  "X-CW-Public-Key": "pub",
  "X-CW-Private-Key": "priv",
  "X-CW-Client-Id": "client-guid",
};

interface ToolResult {
  content: { text: string }[];
  isError?: boolean;
}

async function mcp<T = ToolResult>(method: string, params: unknown): Promise<{ result: T }> {
  const response = await worker.fetch(
    new Request("http://worker.local/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    { AUTH_MODE: "gateway" },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { result: T };
}

async function call(name: string, args: unknown): Promise<ToolResult> {
  return (await mcp("tools/call", { name, arguments: args })).result;
}

function json(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

interface MockOptions {
  /** A PATCH answers 200 but keeps these fields as they were, as ConnectWise sometimes does. */
  ignoreOnPatch?: string[];
  /** The id a POST to /items gives the new record. */
  newItemId?: number;
  /** What a POST stores, to simulate ConnectWise changing a value. */
  postOverride?: Record<string, unknown>;
}

/** Board 1 with two items, one subtype linked to type 1, and types 1 and 2. */
function mockBoard(options: MockOptions = {}) {
  const sent: Sent[] = [];
  const board = { id: 1, name: "Incident Board" };
  const store: Record<string, Record<string, unknown> | Array<Record<string, unknown>>> = {
    "/service/boards/1/items": [
      { id: 11, name: "Printer", inactiveFlag: false, board },
      { id: 12, name: "Old VPN", inactiveFlag: true, board },
    ],
    "/service/boards/1/items/11": { id: 11, name: "Printer", inactiveFlag: false, board },
    "/service/boards/1/items/12": { id: 12, name: "Old VPN", inactiveFlag: true, board },
    "/service/boards/1/items/77": { id: 77, name: "Other board item", inactiveFlag: false, board: { id: 2, name: "Other" } },
    "/service/boards/1/subtypes/21": { id: 21, name: "Hardware", inactiveFlag: false, typeAssociationIds: [1], board },
    "/service/boards/1/subtypes/22": { id: 22, name: "Elsewhere", inactiveFlag: false, typeAssociationIds: [], board: { id: 2, name: "Other" } },
    "/service/boards/1/types": [
      { id: 1, name: "Incident", inactiveFlag: false },
      { id: 2, name: "Request", inactiveFlag: false },
    ],
  };

  const fetchMock = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname.replace("/v4_6_release/apis/3.0", "");
    const method = String(init.method ?? "GET");
    const body = init.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    sent.push({ method, path, body });

    if (method === "GET") {
      if (!(path in store)) return jsonResponse({ code: "NotFound", message: `Unexpected ${path}` }, 404);
      const answer = store[path];
      if (Array.isArray(answer) && parsed.searchParams.get("page") !== "1") return jsonResponse([]);
      return jsonResponse(answer);
    }
    if (method === "POST" && path === "/service/boards/1/items") {
      const id = options.newItemId ?? 99;
      const record = { id, board, ...(body as object), ...(options.postOverride ?? {}) };
      store[`/service/boards/1/items/${id}`] = record;
      (store["/service/boards/1/items"] as Array<Record<string, unknown>>).push(record);
      return jsonResponse(record, 201);
    }
    if (method === "PATCH" && path in store && !Array.isArray(store[path])) {
      const record = store[path] as Record<string, unknown>;
      for (const op of body as Array<{ op: string; path: string; value: unknown }>) {
        const field = op.path.slice(1);
        if (op.op === "replace" && !options.ignoreOnPatch?.includes(field)) record[field] = op.value;
      }
      return jsonResponse(record);
    }
    return jsonResponse({ code: "Unexpected", message: `${method} ${path}` }, 405);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { sent, store, fetchMock, writes: () => sent.filter((entry) => entry.method !== "GET") };
}

afterEach(() => vi.unstubAllGlobals());

const WRITE_TOOLS = ["cw_create_board_item", "cw_update_board_item", "cw_update_board_subtype"];

describe("board item and subtype writes, registration", () => {
  it("registers the three tools as writes that take confirm", async () => {
    const tools = (
      await mcp<{ tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean }; inputSchema: { properties: Record<string, unknown> } }> }>(
        "tools/list",
        {},
      )
    ).result.tools;
    for (const name of WRITE_TOOLS) {
      const tool = tools.find((entry) => entry.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.annotations?.readOnlyHint, name).toBe(false);
      expect(tool!.inputSchema.properties, name).toHaveProperty("confirm");
    }
  });

  it("registers no delete tool for an item, a subtype or an association", async () => {
    const tools = (await mcp<{ tools: Array<{ name: string }> }>("tools/list", {})).result.tools;
    expect(tools.map((tool) => tool.name).filter((name) => /^cw_(delete|remove)_.*(board|subtype|item_association)/.test(name))).toEqual([]);
  });

  it("makes no write from any of the three tools when confirm is missing or false", async () => {
    const cw = mockBoard();
    const calls: Array<[string, Record<string, unknown>]> = [
      ["cw_create_board_item", { boardId: 1, name: "Scanner" }],
      ["cw_update_board_item", { boardId: 1, itemId: 11, name: "Printers", inactiveFlag: true }],
      ["cw_update_board_subtype", { boardId: 1, subtypeId: 21, name: "Devices", addTypeIds: [2] }],
    ];
    for (const [name, args] of calls) {
      for (const extra of [{}, { confirm: false }]) {
        const result = await call(name, { ...args, ...extra });
        expect(result.isError, name).toBe(true);
        expect(json(result), name).toHaveProperty("planned");
        expect(json(result), name).toHaveProperty("before");
      }
    }
    expect(cw.writes()).toEqual([]);
  });
});

describe("cw_create_board_item", () => {
  it("returns the plan and the before-image without confirm", async () => {
    mockBoard();
    const out = json(await call("cw_create_board_item", { boardId: 1, name: "Scanner", inactiveFlag: false }));
    expect(out).toMatchObject({
      created: false,
      before: { itemCount: 2 },
      planned: { create: { name: "Scanner", inactiveFlag: false } },
    });
  });

  it("reports an item of the same name, ignoring case, and writes nothing", async () => {
    const cw = mockBoard();
    const result = await call("cw_create_board_item", { boardId: 1, name: "printer", confirm: true });
    expect(result.isError).not.toBe(true);
    expect(json(result)).toMatchObject({ created: false, alreadyPresent: true, existing: [{ id: 11, name: "Printer" }] });
    expect(cw.writes()).toEqual([]);
  });

  it("posts the name once with confirm and reads the new item back", async () => {
    const cw = mockBoard({ newItemId: 99 });
    const result = await call("cw_create_board_item", { boardId: 1, name: "Scanner", confirm: true });
    expect(result.isError).not.toBe(true);
    expect(json(result)).toEqual({
      created: true,
      verified: true,
      boardId: 1,
      before: { itemCount: 2 },
      after: { id: 99, name: "Scanner", inactiveFlag: false, boardId: 1 },
    });
    expect(cw.writes()).toEqual([{ method: "POST", path: "/service/boards/1/items", body: { name: "Scanner" } }]);
    expect(cw.sent.at(-1)).toMatchObject({ method: "GET", path: "/service/boards/1/items/99" });
  });

  it("sends inactiveFlag when given", async () => {
    const cw = mockBoard();
    await call("cw_create_board_item", { boardId: 1, name: "Retired", inactiveFlag: true, confirm: true });
    expect(cw.writes()[0].body).toEqual({ name: "Retired", inactiveFlag: true });
  });

  it("reports a value ConnectWise changed as not verified", async () => {
    mockBoard({ postOverride: { name: "Scanner (renamed)" } });
    const result = await call("cw_create_board_item", { boardId: 1, name: "Scanner", confirm: true });
    expect(result.isError).toBe(true);
    expect(json(result)).toMatchObject({ created: true, verified: false });
  });

  it("refuses an empty name, a name over 50 characters and a bad board id before any request", async () => {
    const cw = mockBoard();
    for (const args of [{ boardId: 1, name: "  " }, { boardId: 1, name: "x".repeat(51) }, { boardId: 0, name: "ok" }]) {
      expect((await call("cw_create_board_item", { ...args, confirm: true })).isError).toBe(true);
    }
    expect(cw.fetchMock).not.toHaveBeenCalled();
  });
});

describe("cw_update_board_item", () => {
  it("returns the before-image and the operations without confirm", async () => {
    mockBoard();
    const out = json(await call("cw_update_board_item", { boardId: 1, itemId: 11, name: "Printers", inactiveFlag: true }));
    expect(out).toMatchObject({
      updated: false,
      before: { id: 11, name: "Printer", inactiveFlag: false, boardId: 1 },
      planned: {
        operations: [
          { op: "replace", path: "/name", value: "Printers" },
          { op: "replace", path: "/inactiveFlag", value: true },
        ],
      },
    });
  });

  it("patches only the fields that differ, then reads back and verifies", async () => {
    const cw = mockBoard();
    const result = await call("cw_update_board_item", { boardId: 1, itemId: 11, name: "Printer", inactiveFlag: true, confirm: true });
    expect(result.isError).not.toBe(true);
    expect(json(result)).toMatchObject({
      updated: true,
      verified: true,
      mismatches: [],
      before: { inactiveFlag: false },
      after: { id: 11, name: "Printer", inactiveFlag: true },
    });
    expect(cw.writes()).toEqual([
      { method: "PATCH", path: "/service/boards/1/items/11", body: [{ op: "replace", path: "/inactiveFlag", value: true }] },
    ]);
    // Read before, patch, read after.
    expect(cw.sent.map((entry) => entry.method)).toEqual(["GET", "PATCH", "GET"]);
  });

  it("switches an inactive item back on", async () => {
    const cw = mockBoard();
    await call("cw_update_board_item", { boardId: 1, itemId: 12, inactiveFlag: false, confirm: true });
    expect(cw.store["/service/boards/1/items/12"]).toMatchObject({ inactiveFlag: false });
  });

  it("reports a change ConnectWise did not keep as a mismatch, not as done", async () => {
    mockBoard({ ignoreOnPatch: ["inactiveFlag"] });
    const result = await call("cw_update_board_item", { boardId: 1, itemId: 11, inactiveFlag: true, confirm: true });
    expect(result.isError).toBe(true);
    expect(json(result)).toMatchObject({
      updated: true,
      verified: false,
      mismatches: [{ field: "inactiveFlag", wanted: true, found: false }],
    });
  });

  it("reports no change and writes nothing when the item already has the values", async () => {
    const cw = mockBoard();
    const result = await call("cw_update_board_item", { boardId: 1, itemId: 11, name: "Printer", inactiveFlag: false, confirm: true });
    expect(result.isError).not.toBe(true);
    expect(json(result)).toMatchObject({ updated: false, noChange: true });
    expect(cw.writes()).toEqual([]);
  });

  it("refuses an item that is on another board", async () => {
    const cw = mockBoard();
    const result = await call("cw_update_board_item", { boardId: 1, itemId: 77, inactiveFlag: true, confirm: true });
    expect(result.isError).toBe(true);
    expect(json(result)).toMatchObject({ refused: true, before: { id: 77, boardId: 2 } });
    expect(cw.writes()).toEqual([]);
  });

  it("refuses a call that names no field to change, before any request", async () => {
    const cw = mockBoard();
    const result = await call("cw_update_board_item", { boardId: 1, itemId: 11, confirm: true });
    expect(result.isError).toBe(true);
    expect(cw.fetchMock).not.toHaveBeenCalled();
  });

  it("changes no field other than name and inactiveFlag", async () => {
    const cw = mockBoard();
    const result = await call("cw_update_board_item", { boardId: 1, itemId: 11, parentId: 5, confirm: true });
    // An unknown field is dropped by the schema, so the call has nothing to change.
    expect(result.isError).toBe(true);
    expect(cw.writes()).toEqual([]);
  });
});

describe("cw_update_board_subtype", () => {
  it("returns the before-image and the full resulting link list without confirm", async () => {
    mockBoard();
    const out = json(await call("cw_update_board_subtype", { boardId: 1, subtypeId: 21, addTypeIds: [2] }));
    expect(out).toMatchObject({
      updated: false,
      before: { id: 21, name: "Hardware", typeAssociationIds: [1] },
      planned: { operations: [{ op: "replace", path: "/typeAssociationIds", value: [1, 2] }] },
    });
  });

  it("adds a type link, patches the full list, and reads back to verify", async () => {
    const cw = mockBoard();
    const result = await call("cw_update_board_subtype", { boardId: 1, subtypeId: 21, addTypeIds: [2], confirm: true });
    expect(result.isError).not.toBe(true);
    expect(json(result)).toMatchObject({
      updated: true,
      verified: true,
      before: { typeAssociationIds: [1] },
      after: { typeAssociationIds: [1, 2] },
    });
    expect(cw.writes()).toEqual([
      { method: "PATCH", path: "/service/boards/1/subtypes/21", body: [{ op: "replace", path: "/typeAssociationIds", value: [1, 2] }] },
    ]);
  });

  it("removes a type link and changes the name and inactiveFlag in one patch", async () => {
    const cw = mockBoard();
    const result = await call("cw_update_board_subtype", {
      boardId: 1,
      subtypeId: 21,
      name: "Devices",
      inactiveFlag: true,
      removeTypeIds: [1],
      confirm: true,
    });
    expect(json(result)).toMatchObject({ verified: true, after: { name: "Devices", inactiveFlag: true, typeAssociationIds: [] } });
    expect(cw.writes()).toHaveLength(1);
    expect(cw.writes()[0].body).toEqual([
      { op: "replace", path: "/name", value: "Devices" },
      { op: "replace", path: "/inactiveFlag", value: true },
      { op: "replace", path: "/typeAssociationIds", value: [] },
    ]);
  });

  it("reports a link change ConnectWise did not keep as a mismatch, not as done", async () => {
    mockBoard({ ignoreOnPatch: ["typeAssociationIds"] });
    const result = await call("cw_update_board_subtype", { boardId: 1, subtypeId: 21, addTypeIds: [2], confirm: true });
    expect(result.isError).toBe(true);
    expect(json(result)).toMatchObject({
      updated: true,
      verified: false,
      mismatches: [{ field: "typeAssociationIds", wanted: [1, 2], found: [1] }],
    });
  });

  it("refuses a type id that is not a type on the board, with nothing written", async () => {
    const cw = mockBoard();
    const result = await call("cw_update_board_subtype", { boardId: 1, subtypeId: 21, addTypeIds: [2, 404], confirm: true });
    expect(result.isError).toBe(true);
    expect(json(result)).toMatchObject({ refused: true });
    expect(String(json(result).message)).toContain("404");
    expect(cw.writes()).toEqual([]);
  });

  it("refuses a type id that is in both lists, before any request", async () => {
    const cw = mockBoard();
    const result = await call("cw_update_board_subtype", { boardId: 1, subtypeId: 21, addTypeIds: [2], removeTypeIds: [2], confirm: true });
    expect(result.isError).toBe(true);
    expect(cw.fetchMock).not.toHaveBeenCalled();
  });

  it("reports no change and writes nothing when the links already match", async () => {
    const cw = mockBoard();
    const result = await call("cw_update_board_subtype", { boardId: 1, subtypeId: 21, addTypeIds: [1], removeTypeIds: [2], confirm: true });
    expect(result.isError).not.toBe(true);
    expect(json(result)).toMatchObject({ updated: false, noChange: true });
    expect(cw.writes()).toEqual([]);
  });

  it("refuses a subtype that is on another board", async () => {
    const cw = mockBoard();
    const result = await call("cw_update_board_subtype", { boardId: 1, subtypeId: 22, inactiveFlag: true, confirm: true });
    expect(result.isError).toBe(true);
    expect(json(result)).toMatchObject({ refused: true, before: { id: 22, boardId: 2 } });
    expect(cw.writes()).toEqual([]);
  });
});

describe("board item and subtype writes, request methods", () => {
  it("sends only GET, POST and PATCH across every write path, never DELETE or PUT", async () => {
    const cw = mockBoard();
    await call("cw_create_board_item", { boardId: 1, name: "Scanner", confirm: true });
    await call("cw_update_board_item", { boardId: 1, itemId: 11, name: "Printers", confirm: true });
    await call("cw_update_board_subtype", { boardId: 1, subtypeId: 21, addTypeIds: [2], confirm: true });
    const methods = new Set(cw.sent.map((entry) => entry.method));
    expect([...methods].sort()).toEqual(["GET", "PATCH", "POST"]);
    expect(cw.writes().every((entry) => !entry.path.includes("typeSubTypeItemAssociations"))).toBe(true);
  });

  it("reports an upstream failure with the status and a reference, never the body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ code: "Forbidden", message: "No permission", trace: "SECRET upstream body" }, 403)),
    );
    const result = await call("cw_update_board_item", { boardId: 1, itemId: 11, inactiveFlag: true, confirm: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/returned 403 \(reference /);
    expect(result.content[0].text).not.toContain("SECRET");
  });
});

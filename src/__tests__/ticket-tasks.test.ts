/**
 * Tests for the service ticket task tools.
 *
 * The tools are driven through the Worker's MCP endpoint in gateway mode, the
 * same way the ticket configuration tests are, so the registration, the input
 * schema and the outbound request are all covered.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../worker.js";
import { buildTicketTaskPatch, toLeanTicketTask } from "../tools/ticket-tasks.js";

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

interface ListedTool {
  name: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  inputSchema: { required?: string[]; properties: Record<string, unknown> };
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

async function listTools(): Promise<ListedTool[]> {
  return (await mcp<{ tools: ListedTool[] }>("tools/list", {})).result.tools;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A task as ConnectWise returns it, with the fields the lean shape drops. */
function cwTask(over: Record<string, unknown> = {}) {
  return {
    id: 501,
    ticketId: 77,
    notes: "Clear the inbox",
    closedFlag: false,
    priority: 1,
    resolution: "",
    schedule: { id: 9, name: "Do Not Schedule" },
    _info: { lastUpdated: "2026-10-12T00:00:00Z", updatedBy: "someone" },
    ...over,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("toLeanTicketTask", () => {
  it("keeps only id, notes, closedFlag, priority and resolution", () => {
    expect(toLeanTicketTask(cwTask({ resolution: "Done" }))).toEqual({
      id: 501,
      notes: "Clear the inbox",
      closedFlag: false,
      priority: 1,
      resolution: "Done",
    });
  });

  it("gives every key a value when ConnectWise omits a field", () => {
    expect(toLeanTicketTask({ id: 7 })).toEqual({
      id: 7,
      notes: null,
      closedFlag: false,
      priority: null,
      resolution: null,
    });
  });
});

describe("cw_get_ticket_tasks", () => {
  it("is registered read-only and takes only the ticket id", async () => {
    const tool = (await listTools()).find((entry) => entry.name === "cw_get_ticket_tasks")!;
    expect(tool).toBeDefined();
    expect(tool.annotations).toMatchObject({ readOnlyHint: true });
    expect(Object.keys(tool.inputSchema.properties)).toEqual(["id"]);
    expect(tool.inputSchema.required).toEqual(["id"]);
  });

  it("registers no delete tool for ticket tasks", async () => {
    const names = (await listTools()).map((tool) => tool.name);
    expect(names.filter((name) => /delete.*ticket_task|ticket_task.*delete/.test(name))).toEqual([]);
  });

  it("gets the tasks from the ticket's tasks endpoint and returns them lean, in priority order", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([
        cwTask({ id: 502, notes: "Second", priority: 2, closedFlag: true, resolution: "Done" }),
        cwTask({ id: 501, notes: "First", priority: 1 }),
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await call("cw_get_ticket_tasks", { id: 77 });

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      ticketId: 77,
      count: 2,
      tasks: [
        { id: 501, notes: "First", closedFlag: false, priority: 1, resolution: "" },
        { id: 502, notes: "Second", closedFlag: true, priority: 2, resolution: "Done" },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(url).pathname).toBe("/v4_6_release/apis/3.0/service/tickets/77/tasks");
    expect(init.method).toBe("GET");
  });

  it("returns an empty list for a ticket with no tasks", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([])));

    const result = await call("cw_get_ticket_tasks", { id: 77 });

    expect(JSON.parse(result.content[0].text)).toEqual({ ticketId: 77, count: 0, tasks: [] });
  });

  it("reads a second page when the first page is full", async () => {
    const fullPage = Array.from({ length: 1000 }, (_, index) =>
      cwTask({ id: index + 1, priority: index + 1 }),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(fullPage))
      .mockResolvedValueOnce(jsonResponse([cwTask({ id: 1001, priority: 1001 })]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await call("cw_get_ticket_tasks", { id: 77 });

    expect(JSON.parse(result.content[0].text).count).toBe(1001);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get("page")).toBe("2");
  });

  it("fails, and does not return a partial list, when ConnectWise refuses the read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ code: "Forbidden", message: "no access" }, 403)),
    );

    const result = await call("cw_get_ticket_tasks", { id: 77 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/403/);
  });

  it("rejects a ticket id that is not a positive integer before any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await call("cw_get_ticket_tasks", { id: -1 });

    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("buildTicketTaskPatch", () => {
  it("builds replace operations for closedFlag and notes only", () => {
    expect(buildTicketTaskPatch({ closedFlag: true, notes: "Done today" })).toEqual([
      { op: "replace", path: "closedFlag", value: true },
      { op: "replace", path: "notes", value: "Done today" },
    ]);
  });

  it("builds nothing when neither field is given", () => {
    expect(buildTicketTaskPatch({})).toEqual([]);
  });
});

describe("cw_update_ticket_task", () => {
  /** Every request the tool made, in order. */
  function requests(fetchMock: ReturnType<typeof vi.fn>) {
    return fetchMock.mock.calls.map(([url, init]) => ({
      path: new URL(url).pathname,
      method: init.method,
      body: init.body ? JSON.parse(init.body) : undefined,
    }));
  }

  const taskPath = "/v4_6_release/apis/3.0/service/tickets/77/tasks/501";

  it("is registered as a write and accepts only ticketId, id, closedFlag, notes and confirm", async () => {
    const tool = (await listTools()).find((entry) => entry.name === "cw_update_ticket_task")!;
    expect(tool).toBeDefined();
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(Object.keys(tool.inputSchema.properties)).toEqual([
      "ticketId",
      "id",
      "closedFlag",
      "notes",
      "confirm",
    ]);
    expect(tool.inputSchema.required).toEqual(["ticketId", "id"]);
  });

  it("closes a task with confirm: true, then reads it back", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(cwTask({ closedFlag: true })))
      .mockResolvedValueOnce(jsonResponse(cwTask({ closedFlag: true })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await call("cw_update_ticket_task", {
      ticketId: 77,
      id: 501,
      closedFlag: true,
      confirm: true,
    });

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toEqual({
      saved: true,
      verified: true,
      ticketId: 77,
      task: { id: 501, notes: "Clear the inbox", closedFlag: true, priority: 1, resolution: "" },
    });
    expect(requests(fetchMock)).toEqual([
      {
        path: taskPath,
        method: "PATCH",
        body: [{ op: "replace", path: "closedFlag", value: true }],
      },
      { path: taskPath, method: "GET", body: undefined },
    ]);
  });

  it("returns the fresh read, not the PATCH response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(cwTask({ notes: "from the patch response" })))
      .mockResolvedValueOnce(jsonResponse(cwTask({ notes: "New text" })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await call("cw_update_ticket_task", {
      ticketId: 77,
      id: 501,
      notes: "New text",
      confirm: true,
    });

    expect(JSON.parse(result.content[0].text).task.notes).toBe("New text");
  });

  it("sends only closedFlag and notes, and drops any other field the caller passes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(cwTask({ closedFlag: true, notes: "New text" })))
      .mockResolvedValueOnce(jsonResponse(cwTask({ closedFlag: true, notes: "New text" })));
    vi.stubGlobal("fetch", fetchMock);

    await call("cw_update_ticket_task", {
      ticketId: 77,
      id: 501,
      closedFlag: true,
      notes: "New text",
      priority: 9,
      resolution: "sneaked in",
      schedule: { id: 1 },
      confirm: true,
    });

    expect(requests(fetchMock)[0].body).toEqual([
      { op: "replace", path: "closedFlag", value: true },
      { op: "replace", path: "notes", value: "New text" },
    ]);
  });

  it.each([
    ["confirm omitted", {}],
    ["confirm false", { confirm: false }],
  ])("makes no request and reports the planned change with %s", async (_label, extra) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await call("cw_update_ticket_task", {
      ticketId: 77,
      id: 501,
      closedFlag: true,
      ...extra,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      saved: false,
      ticketId: 77,
      taskId: 501,
      planned: [{ op: "replace", path: "closedFlag", value: true }],
    });
  });

  it("makes no request when neither closedFlag nor notes is given", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await call("cw_update_ticket_task", { ticketId: 77, id: 501, confirm: true });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Nothing to update/);
  });

  it("reports an error when the read-back does not match what was sent", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(cwTask({ closedFlag: true })))
      .mockResolvedValueOnce(jsonResponse(cwTask({ closedFlag: false })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await call("cw_update_ticket_task", {
      ticketId: 77,
      id: 501,
      closedFlag: true,
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      saved: true,
      verified: false,
      mismatches: ["closedFlag"],
    });
  });

  it("fails without a read-back when ConnectWise refuses the write", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ code: "Forbidden", message: "no access" }, 403));
    vi.stubGlobal("fetch", fetchMock);

    const result = await call("cw_update_ticket_task", {
      ticketId: 77,
      id: 501,
      closedFlag: true,
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/403/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

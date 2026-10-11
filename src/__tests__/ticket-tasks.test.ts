/**
 * Tests for the service ticket task tools.
 *
 * The tools are driven through the Worker's MCP endpoint in gateway mode, the
 * same way the ticket configuration tests are, so the registration, the input
 * schema and the outbound request are all covered.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../worker.js";
import { toLeanTicketTask } from "../tools/ticket-tasks.js";

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

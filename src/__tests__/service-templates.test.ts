/**
 * Tests for the service ticket template tools.
 *
 * The tools are driven through the Worker's MCP endpoint in gateway mode, so
 * the registration, the input schema and the outbound request are all covered.
 * ConnectWise is a fake that holds templates, tickets and schedule entries.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../worker.js";
import { daysAgoIso, templateIdFromEnteredBy, toLeanTemplate } from "../tools/templates.js";

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

function json(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

interface FakeState {
  templates: Record<number, Record<string, unknown>>;
  /** Tickets a ticket search returns, whatever the conditions. */
  recentTickets?: Record<string, unknown>[];
  /** Schedule entries a schedule search returns, whatever the conditions. */
  pendingBookings?: Record<string, unknown>[];
  tickets?: Record<number, Record<string, unknown>>;
  scheduleEntries?: Record<number, Record<string, unknown>>;
  /** Answer the template DELETE with this status instead of 204. */
  failDelete?: number;
  /** Answer the note POST with 500. */
  failNote?: boolean;
  /** Accept a PATCH but leave the template as it was. */
  ignorePatch?: boolean;
}

function template(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: "ZZ MCP Test",
    summary: "ZZ MCP Test",
    problem: "A long description the lean shape drops",
    board: { id: 33, name: "Board", _info: { board_href: "x" } },
    status: { id: 2186, name: "Queued" },
    company: { id: 250, identifier: "FLHQ", name: "Future Logic" },
    team: { id: 1127, name: "SJ Only" },
    assignedBy: { id: 147, identifier: "sjenner", name: "Stephan Jenner" },
    templateFlag: false,
    scheduleDaysBefore: 2,
    serviceDaysBefore: 2,
    billTime: "DoNotBill",
    _info: { lastUpdated: "2026-10-13T00:00:00Z", updatedBy: "sjenner" },
    ...over,
  };
}

function fakeConnectWise(state: FakeState) {
  const calls: Call[] = [];
  let noteId = 7000;
  const notes: Record<number, { id: number }[]> = {};

  const fetchMock = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname.replace("/v4_6_release/apis/3.0", "");
    const method = String(init.method ?? "GET");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const query = Object.fromEntries(parsed.searchParams.entries());
    calls.push({ method, path, query, body });
    const firstPage = query.page === undefined || query.page === "1";
    const notFound = () => jsonResponse({ code: "NotFound", message: "Not found" }, 404);

    if (path === "/service/templates" && method === "GET") {
      return jsonResponse(firstPage ? Object.values(state.templates) : []);
    }
    const templateMatch = path.match(/^\/service\/templates\/(\d+)$/);
    if (templateMatch) {
      const id = Number(templateMatch[1]);
      const record = state.templates[id];
      if (!record) return notFound();
      if (method === "GET") return jsonResponse(record);
      if (method === "PATCH") {
        if (!state.ignorePatch) {
          for (const operation of body as { path: string; value: unknown }[]) record[operation.path] = operation.value;
        }
        return jsonResponse(record);
      }
      if (method === "DELETE") {
        if (state.failDelete) return jsonResponse({ code: "Error", message: "No" }, state.failDelete);
        delete state.templates[id];
        return jsonResponse(undefined, 204);
      }
    }
    if (path === "/service/tickets" && method === "GET") {
      return jsonResponse(firstPage ? (state.recentTickets ?? []) : []);
    }
    if (path === "/schedule/entries" && method === "GET") {
      return jsonResponse(firstPage ? (state.pendingBookings ?? []) : []);
    }
    const ticketMatch = path.match(/^\/service\/tickets\/(\d+)$/);
    if (ticketMatch && method === "GET") {
      const ticket = state.tickets?.[Number(ticketMatch[1])];
      return ticket ? jsonResponse(ticket) : notFound();
    }
    const entryMatch = path.match(/^\/schedule\/entries\/(\d+)$/);
    if (entryMatch && method === "GET") {
      const entry = state.scheduleEntries?.[Number(entryMatch[1])];
      return entry ? jsonResponse(entry) : notFound();
    }
    const noteMatch = path.match(/^\/service\/tickets\/(\d+)\/notes$/);
    if (noteMatch) {
      const ticketId = Number(noteMatch[1]);
      if (method === "POST") {
        if (state.failNote) return jsonResponse({ code: "ServerError", message: "boom" }, 500);
        const note = { id: noteId++, ...(body as object) };
        (notes[ticketId] ??= []).unshift(note);
        return jsonResponse(note);
      }
      return jsonResponse(notes[ticketId] ?? []);
    }
    return jsonResponse({ code: "NotFound", message: `Unexpected ${method} ${path}` }, 404);
  });

  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock, state };
}

const noteTicket = { 904995: { id: 904995, summary: "ConnectWise MCP tool batch", company: { id: 250, name: "Future Logic" } } };
const writes = (calls: Call[]) => calls.filter((entry) => entry.method !== "GET");

afterEach(() => vi.unstubAllGlobals());

describe("service template tools, registration", () => {
  it("registers the read tools as read-only and the write tools with confirm", async () => {
    const tools = (await mcp<{ tools: ListedTool[] }>("tools/list", {})).result.tools;
    const find = (name: string) => tools.find((entry) => entry.name === name)!;
    for (const name of ["cw_list_service_templates", "cw_get_service_template", "cw_trace_template_source"]) {
      expect(find(name), name).toBeDefined();
      expect(find(name).annotations, name).toMatchObject({ readOnlyHint: true });
      expect(find(name).inputSchema.properties, name).not.toHaveProperty("confirm");
    }
    for (const name of ["cw_update_service_template", "cw_delete_service_template"]) {
      expect(find(name), name).toBeDefined();
      expect(find(name).annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(find(name).inputSchema.properties, name).toHaveProperty("confirm");
    }
    expect(find("cw_delete_service_template").inputSchema.required?.sort()).toEqual(["id", "noteTicketId", "reason"]);
  });

  it("registers no tool that generates from a template or makes one", async () => {
    const names = (await mcp<{ tools: ListedTool[] }>("tools/list", {})).result.tools.map((tool) => tool.name);
    expect(names.filter((name) => /template/.test(name)).sort()).toEqual([
      "cw_delete_service_template",
      "cw_get_service_template",
      "cw_list_service_templates",
      "cw_trace_template_source",
      "cw_update_service_template",
    ]);
  });
});

describe("cw_list_service_templates and cw_get_service_template", () => {
  it("lists templates lean and builds the filters", async () => {
    const cw = fakeConnectWise({ templates: { 539: template(539, { name: "FL-SJ-Clearing the Decks" }) } });
    const out = json(
      await call("cw_list_service_templates", { companyId: 250, boardId: 33, nameContains: "Clearing" }),
    ) as { count: number; templates: Array<Record<string, unknown>> };
    expect(out.count).toBe(1);
    expect(out.templates[0]).toEqual({
      id: 539,
      name: "FL-SJ-Clearing the Decks",
      summary: "ZZ MCP Test",
      board: { id: 33, name: "Board" },
      status: { id: 2186, name: "Queued" },
      company: { id: 250, name: "Future Logic" },
      team: { id: 1127, name: "SJ Only" },
      type: null,
      assignedBy: { id: 147, name: "Stephan Jenner" },
      templateFlag: false,
      scheduleDaysBefore: 2,
      serviceDaysBefore: 2,
      _info: { lastUpdated: "2026-10-13T00:00:00Z", updatedBy: "sjenner" },
    });
    expect(cw.calls[0].query.conditions).toBe("(company/id=250) and (board/id=33) and (name contains 'Clearing')");
  });

  it("refuses a name filter that could break out of the condition, before any request", async () => {
    const cw = fakeConnectWise({ templates: {} });
    for (const nameContains of ["a' or id>0 or name='", 'a"b', "a*"]) {
      expect((await call("cw_list_service_templates", { nameContains })).isError).toBe(true);
    }
    expect(cw.fetchMock).not.toHaveBeenCalled();
  });

  it("gets the full template with the tickets and bookings it has made", async () => {
    const cw = fakeConnectWise({
      templates: { 562: template(562) },
      recentTickets: [{ id: 903832, summary: "Visit", closedFlag: false, _info: { dateEntered: "2026-10-01T17:00:05Z" } }],
      pendingBookings: [{ id: 1, name: "Visit", member: { identifier: "cappleton" }, dateStart: "2026-12-09T00:30:00Z", dateEnd: "2026-12-09T01:00:00Z" }],
    });
    const out = json(await call("cw_get_service_template", { id: 562 })) as {
      template: Record<string, unknown>;
      usage: Record<string, unknown>;
    };
    expect(out.template).toMatchObject({ id: 562, problem: "A long description the lean shape drops" });
    expect(out.usage).toEqual({
      recentTicketCount: 1,
      recentTickets: [{ id: 903832, summary: "Visit", closedFlag: false, dateEntered: "2026-10-01T17:00:05Z" }],
      pendingBookings: [{ id: 1, name: "Visit", member: "cappleton", dateStart: "2026-12-09T00:30:00Z", dateEnd: "2026-12-09T01:00:00Z" }],
    });
    const tickets = cw.calls.find((entry) => entry.path === "/service/tickets")!;
    expect(tickets.query.conditions).toMatch(/^enteredBy='template562' and dateEntered>=\[\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\]$/);
    const bookings = cw.calls.find((entry) => entry.path === "/schedule/entries")!;
    expect(bookings.query.conditions).toBe("type/id=12 and objectId=562 and doneFlag=false");
    expect(writes(cw.calls)).toEqual([]);
  });
});

describe("cw_trace_template_source", () => {
  const state = (): FakeState => ({
    templates: { 562: template(562, { name: "PDSV - Cameron - Outdoors WA " }) },
    tickets: {
      903832: { id: 903832, summary: "PDSV visit", company: { id: 1, name: "Outdoors WA Inc." }, board: { id: 35, name: "Site Visit" }, _info: { enteredBy: "template562", dateEntered: "2026-10-01T17:00:05Z" } },
      5: { id: 5, summary: "Typed in", _info: { enteredBy: "kJandayan" } },
      6: { id: 6, summary: "Orphan", _info: { enteredBy: "template999" } },
    },
    scheduleEntries: {
      1078158: { id: 1078158, name: "Gambara/PDSV", objectId: 562, type: { id: 12, identifier: "R" }, dateStart: "2026-12-09T00:30:00Z", _info: { enteredBy: "Template562" } },
    },
  });

  it("traces a ticket to the template that generated it", async () => {
    const cw = fakeConnectWise(state());
    const out = json(await call("cw_trace_template_source", { ticketId: 903832 }));
    expect(out).toMatchObject({
      source: { kind: "ticket", id: 903832, enteredBy: "template562", company: { name: "Outdoors WA Inc." } },
      generatedByTemplate: true,
      templateId: 562,
      found: true,
      template: { id: 562, name: "PDSV - Cameron - Outdoors WA " },
    });
    expect(cw.calls.map((entry) => entry.path)).toEqual(["/service/tickets/903832", "/service/templates/562"]);
  });

  it("traces a schedule entry to its template, whatever the case of the stamp", async () => {
    fakeConnectWise(state());
    const out = json(await call("cw_trace_template_source", { scheduleEntryId: 1078158 }));
    expect(out).toMatchObject({
      source: { kind: "scheduleEntry", id: 1078158, objectId: 562, type: { id: 12, name: "R" } },
      generatedByTemplate: true,
      templateId: 562,
      found: true,
    });
  });

  it("says plainly when a member entered the record, and reads no template", async () => {
    const cw = fakeConnectWise(state());
    const out = json(await call("cw_trace_template_source", { ticketId: 5 }));
    expect(out).toMatchObject({ generatedByTemplate: false });
    expect(String(out.message)).toMatch(/entered by kJandayan/);
    expect(cw.calls).toHaveLength(1);
  });

  it("reports a template that no longer exists", async () => {
    fakeConnectWise(state());
    const result = await call("cw_trace_template_source", { ticketId: 6 });
    expect(result.isError).not.toBe(true);
    expect(json(result)).toMatchObject({ generatedByTemplate: true, templateId: 999, found: false });
  });

  it("refuses both ids, or neither, before any request", async () => {
    const cw = fakeConnectWise(state());
    expect((await call("cw_trace_template_source", {})).isError).toBe(true);
    expect((await call("cw_trace_template_source", { ticketId: 1, scheduleEntryId: 2 })).isError).toBe(true);
    expect(cw.fetchMock).not.toHaveBeenCalled();
  });
});

describe("cw_update_service_template", () => {
  const change = [{ op: "replace", path: "summary", value: "ZZ MCP Test, edited" }];

  it("writes nothing without confirm: true and returns the plan", async () => {
    const cw = fakeConnectWise({ templates: { 600: template(600) } });
    const result = await call("cw_update_service_template", { id: 600, operations: change });
    expect(result.isError).toBe(true);
    expect(json(result)).toMatchObject({ saved: false, planned: change, template: { id: 600, summary: "ZZ MCP Test" } });
    expect(writes(cw.calls)).toEqual([]);
    expect(cw.state.templates[600].summary).toBe("ZZ MCP Test");
  });

  it("patches with confirm: true and verifies against a fresh read", async () => {
    const cw = fakeConnectWise({ templates: { 600: template(600) } });
    const result = await call("cw_update_service_template", { id: 600, operations: change, confirm: true });
    expect(result.isError).not.toBe(true);
    expect(json(result)).toMatchObject({ saved: true, verified: true, template: { id: 600, summary: "ZZ MCP Test, edited" } });
    expect(cw.calls.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
      "GET /service/templates/600",
      "PATCH /service/templates/600",
      "GET /service/templates/600",
    ]);
    expect(cw.calls[1].body).toEqual(change);
  });

  it("reports a value the fresh read does not hold", async () => {
    fakeConnectWise({ templates: { 600: template(600) }, ignorePatch: true });
    const result = await call("cw_update_service_template", { id: 600, operations: change, confirm: true });
    expect(result.isError).toBe(true);
    expect(json(result)).toMatchObject({ saved: true, verified: false, mismatches: ["summary"] });
  });

  it("refuses a patch on the id, or with no value, before any request", async () => {
    const cw = fakeConnectWise({ templates: { 600: template(600) } });
    for (const operations of [[{ op: "replace", path: "id", value: 1 }], [{ op: "replace", path: "/id", value: 1 }], [{ op: "replace", path: "summary" }]]) {
      expect((await call("cw_update_service_template", { id: 600, operations, confirm: true })).isError).toBe(true);
    }
    expect(cw.fetchMock).not.toHaveBeenCalled();
  });

  it("fails on a template that does not exist, with nothing written", async () => {
    const cw = fakeConnectWise({ templates: {} });
    const result = await call("cw_update_service_template", { id: 600, operations: change, confirm: true });
    expect(result.isError).toBe(true);
    expect(writes(cw.calls)).toEqual([]);
  });
});

describe("cw_delete_service_template", () => {
  const args = { id: 600, reason: "WS4 test template, no longer needed", noteTicketId: 904995 };

  it("writes nothing without confirm: true and returns the plan with the note text", async () => {
    const cw = fakeConnectWise({ templates: { 600: template(600) }, tickets: noteTicket });
    const result = await call("cw_delete_service_template", args);
    expect(result.isError).toBe(true);
    expect(json(result)).toMatchObject({
      saved: false,
      deleted: false,
      template: { id: 600, name: "ZZ MCP Test" },
      note: {
        ticketId: 904995,
        ticketSummary: "ConnectWise MCP tool batch",
        text: "Service template 600 was deleted. Name: ZZ MCP Test. Company: Future Logic. Board: Board. Reason: WS4 test template, no longer needed",
      },
    });
    expect(writes(cw.calls)).toEqual([]);
    expect(cw.state.templates[600]).toBeDefined();
  });

  it("deletes with confirm: true, adds the internal note, and reads both back", async () => {
    const cw = fakeConnectWise({ templates: { 600: template(600) }, tickets: noteTicket });
    const result = await call("cw_delete_service_template", { ...args, confirm: true });
    expect(result.isError).not.toBe(true);
    expect(json(result)).toMatchObject({
      deleted: true,
      verified: true,
      templateGone: true,
      note: { added: true, id: 7000, readBack: true, ticketId: 904995 },
    });
    expect(writes(cw.calls).map((entry) => `${entry.method} ${entry.path}`)).toEqual([
      "DELETE /service/templates/600",
      "POST /service/tickets/904995/notes",
    ]);
    expect(writes(cw.calls)[1].body).toMatchObject({ internalAnalysisFlag: true });
    expect(cw.state.templates[600]).toBeUndefined();
  });

  it("refuses a template that generated a ticket in the last 90 days (D16)", async () => {
    const cw = fakeConnectWise({
      templates: { 600: template(600) },
      tickets: noteTicket,
      recentTickets: [{ id: 903832, summary: "Visit", _info: { dateEntered: "2026-10-01T17:00:05Z" } }],
    });
    const result = await call("cw_delete_service_template", { ...args, confirm: true });
    expect(result.isError).toBe(true);
    expect(json(result)).toMatchObject({ deleted: false, reason: "recent-tickets", recentTickets: [{ id: 903832 }] });
    expect(writes(cw.calls)).toEqual([]);
    expect(cw.state.templates[600]).toBeDefined();
  });

  it("refuses a template with a booking that is not done yet", async () => {
    const cw = fakeConnectWise({
      templates: { 600: template(600) },
      tickets: noteTicket,
      pendingBookings: [{ id: 1078158, name: "Visit", dateStart: "2026-12-09T00:30:00Z" }],
    });
    const result = await call("cw_delete_service_template", { ...args, confirm: true });
    expect(result.isError).toBe(true);
    expect(json(result)).toMatchObject({ deleted: false, reason: "pending-bookings", pendingBookings: [{ id: 1078158 }] });
    expect(writes(cw.calls)).toEqual([]);
  });

  it("deletes nothing when the note ticket cannot be read", async () => {
    const cw = fakeConnectWise({ templates: { 600: template(600) }, tickets: {} });
    const result = await call("cw_delete_service_template", { ...args, confirm: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/\/service\/tickets\/904995 returned 404/);
    expect(writes(cw.calls)).toEqual([]);
    expect(cw.state.templates[600]).toBeDefined();
  });

  it("adds no note when ConnectWise refuses the delete", async () => {
    const cw = fakeConnectWise({ templates: { 600: template(600) }, tickets: noteTicket, failDelete: 409 });
    const result = await call("cw_delete_service_template", { ...args, confirm: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/DELETE \/service\/templates\/600 returned 409/);
    expect(cw.calls.filter((entry) => entry.method === "POST")).toEqual([]);
    expect(cw.state.templates[600]).toBeDefined();
  });

  it("says the template is gone and gives the note text when the note fails", async () => {
    fakeConnectWise({ templates: { 600: template(600) }, tickets: noteTicket, failNote: true });
    const result = await call("cw_delete_service_template", { ...args, confirm: true });
    expect(result.isError).toBe(true);
    const out = json(result);
    expect(out).toMatchObject({ deleted: true, verified: false, templateGone: true, note: { added: false, readBack: false } });
    expect(String(out.warning)).toMatch(/Add the note text above to the ticket by hand/);
  });

  it("needs a reason and a note ticket before any request", async () => {
    const cw = fakeConnectWise({ templates: { 600: template(600) }, tickets: noteTicket });
    expect((await call("cw_delete_service_template", { id: 600, noteTicketId: 904995, confirm: true })).isError).toBe(true);
    expect((await call("cw_delete_service_template", { id: 600, reason: "  ", noteTicketId: 904995, confirm: true })).isError).toBe(true);
    expect((await call("cw_delete_service_template", { id: 600, reason: "Test done", confirm: true })).isError).toBe(true);
    expect(cw.fetchMock).not.toHaveBeenCalled();
  });
});

describe("template shapes", () => {
  it("templateIdFromEnteredBy reads only a template stamp", () => {
    expect(templateIdFromEnteredBy("template562")).toBe(562);
    expect(templateIdFromEnteredBy(" Template490 ")).toBe(490);
    for (const other of ["kJandayan", "template", "template12a", "mytemplate5", "", null, 562]) {
      expect(templateIdFromEnteredBy(other)).toBeNull();
    }
  });

  it("daysAgoIso gives the time that many days before, to the second", () => {
    expect(daysAgoIso(90, new Date("2026-10-13T09:15:30.123Z"))).toBe("2026-07-15T09:15:30Z");
  });

  it("toLeanTemplate holds stable keys for a template with almost nothing set", () => {
    expect(toLeanTemplate({ id: 1 })).toEqual({
      id: 1,
      name: null,
      summary: null,
      board: null,
      status: null,
      company: null,
      team: null,
      type: null,
      assignedBy: null,
      templateFlag: null,
      scheduleDaysBefore: null,
      serviceDaysBefore: null,
      _info: { lastUpdated: null, updatedBy: null },
    });
  });
});

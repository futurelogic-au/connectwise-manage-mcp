/**
 * Tests for WS3 Group 2, dispatch: cw_delete_schedule_entry (D9, D10),
 * cw_merge_tickets (D11) and the inactive company handling (D12).
 *
 * The tools are driven through the Worker's MCP endpoint in gateway mode. A
 * small in-test fake stands in for the ConnectWise endpoints the tools call, so
 * the read backs are exercised against state. Test infrastructure only: nothing
 * here is a live ConnectWise result, and no test makes a network call.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../worker.js";
import { formatPerth, linkedTicketPath } from "../tools/schedule.js";
import { isInactiveCompanyError, touchesCompany } from "../tools/ticket-company.js";

const headers = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
  "X-CW-Company-Id": "acme",
  "X-CW-Public-Key": "pub",
  "X-CW-Private-Key": "priv",
  "X-CW-Client-Id": "client-guid",
};

interface ToolResult {
  content: { type: string; text: string }[];
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

function body(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const INACTIVE_MESSAGE = "This company is in a status that does not allow saving Service Ticket";

type Rec = Record<string, unknown>;

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

interface FakeState {
  tickets: Record<number, Rec>;
  entries: Record<number, Rec>;
  timeEntries: Rec[];
  companies: Record<number, Rec>;
  /** Statuses by board id. */
  statuses: Record<number, Rec[]>;
  /** Company ids that ConnectWise refuses to save a ticket for. */
  inactiveCompanies: number[];
  /** Ticket ids whose note POST answers 500. */
  failNoteOn: number[];
}

/** A fake ConnectWise holding tickets, schedule entries, time entries, companies and statuses. */
function fakeConnectWise(initial: Partial<FakeState>) {
  const state: FakeState = {
    tickets: {},
    entries: {},
    timeEntries: [],
    companies: {},
    statuses: {},
    inactiveCompanies: [],
    failNoteOn: [],
    ...initial,
  };
  const calls: Call[] = [];
  const notes: Record<string, Rec[]> = {};
  let noteId = 7000;

  const setPath = (record: Rec, path: string, value: unknown) => {
    const segments = path.split("/").filter(Boolean);
    let cursor = record;
    for (const segment of segments.slice(0, -1)) {
      cursor[segment] = (cursor[segment] as Rec) ?? {};
      cursor = cursor[segment] as Rec;
    }
    cursor[segments[segments.length - 1]] = value;
  };

  const fetchMock = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname.replace("/v4_6_release/apis/3.0", "");
    const method = String(init.method ?? "GET");
    const payload = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, query: parsed.searchParams, body: payload });

    let m: RegExpMatchArray | null;

    if ((m = path.match(/^\/schedule\/entries\/(\d+)$/))) {
      const id = Number(m[1]);
      if (!state.entries[id]) return jsonResponse({ code: "NotFound", message: "Not found" }, 404);
      if (method === "GET") return jsonResponse(state.entries[id]);
      if (method === "DELETE") {
        delete state.entries[id];
        return jsonResponse(undefined, 204);
      }
    }

    if (path === "/time/entries" && method === "GET") return jsonResponse(state.timeEntries);

    if ((m = path.match(/^\/(service|project)\/tickets\/(\d+)\/notes$/))) {
      const key = `${m[1]}:${m[2]}`;
      const id = Number(m[2]);
      if (method === "POST") {
        if (state.failNoteOn.includes(id)) return jsonResponse({ code: "ServerError", message: "boom" }, 500);
        const note = { id: noteId++, ...(payload as Rec) };
        (notes[key] ??= []).unshift(note);
        return jsonResponse(note);
      }
      if (method === "GET") return jsonResponse(notes[key] ?? []);
    }

    if ((m = path.match(/^\/service\/boards\/(\d+)\/statuses$/))) {
      return jsonResponse(state.statuses[Number(m[1])] ?? []);
    }

    if ((m = path.match(/^\/company\/companies\/(\d+)$/))) {
      const company = state.companies[Number(m[1])];
      return company ? jsonResponse(company) : jsonResponse({ code: "NotFound", message: "Not found" }, 404);
    }

    if ((m = path.match(/^\/service\/tickets\/(\d+)\/merge$/)) && method === "POST") {
      const parent = state.tickets[Number(m[1])];
      const companyId = (parent?.company as Rec | undefined)?.id as number;
      if (state.inactiveCompanies.includes(companyId)) {
        return jsonResponse({ code: "InvalidObject", message: INACTIVE_MESSAGE }, 400);
      }
      const { mergeTicketIds, status } = payload as { mergeTicketIds: number[]; status: { id: number } };
      for (const childId of mergeTicketIds) {
        state.tickets[childId].closedFlag = true;
        state.tickets[childId].status = { id: status.id, name: `status ${status.id}` };
      }
      return jsonResponse(undefined, 204);
    }

    if (path === "/service/tickets" && method === "POST") {
      const companyId = ((payload as Rec).company as Rec | undefined)?.id as number;
      if (state.inactiveCompanies.includes(companyId)) {
        return jsonResponse({ code: "InvalidObject", message: INACTIVE_MESSAGE }, 400);
      }
      return jsonResponse({ id: 999, ...(payload as Rec) });
    }

    if ((m = path.match(/^\/service\/tickets\/(\d+)$/))) {
      const id = Number(m[1]);
      const ticket = state.tickets[id];
      if (!ticket) return jsonResponse({ code: "NotFound", message: "Not found" }, 404);
      if (method === "GET") return jsonResponse(ticket);
      if (method === "PATCH") {
        const operations = payload as { op: string; path: string; value: unknown }[];
        const movesTo = operations.find((o) => o.path === "company/id")?.value as number | undefined;
        const effectiveCompany = movesTo ?? ((ticket.company as Rec).id as number);
        if (state.inactiveCompanies.includes(effectiveCompany)) {
          return jsonResponse({ code: "InvalidObject", message: INACTIVE_MESSAGE }, 400);
        }
        for (const op of operations) setPath(ticket, op.path, op.value);
        return jsonResponse(ticket);
      }
    }

    return jsonResponse({ code: "NotFound", message: `Unexpected ${method} ${path}` }, 404);
  });

  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock, state, notes };
}

const HOUR = 60 * 60 * 1000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, "Z");

function entry(over: Rec = {}): Rec {
  return {
    id: 501,
    objectId: 77,
    name: "Site visit",
    type: { id: 4, name: "Service", identifier: "S" },
    member: { id: 20, identifier: "SJenner", name: "Stephan Jenner" },
    // Two days ahead, two hours long: always in the future.
    dateStart: "2999-01-01T02:00:00Z",
    dateEnd: "2999-01-01T04:00:00Z",
    doneFlag: false,
    ...over,
  };
}

function ticket(id: number, over: Rec = {}): Rec {
  return {
    id,
    summary: `Ticket ${id}`,
    closedFlag: false,
    board: { id: 33, name: "Leadership" },
    status: { id: 1, name: "New" },
    company: { id: 250, name: "Future Logic HQ", identifier: "FLHQ" },
    ...over,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("formatPerth and linkedTicketPath", () => {
  it("shows UTC as Perth time, dd/mm/yyyy hh:mm, across midnight", () => {
    expect(formatPerth("2026-10-14T02:00:00Z")).toBe("14/10/2026 10:00");
    expect(formatPerth("2026-10-14T17:30:00Z")).toBe("15/10/2026 01:30");
    expect(formatPerth("not a date")).toBe("not a date");
  });

  it("links a service entry to a service ticket and a project entry to a project ticket", () => {
    expect(linkedTicketPath({ objectId: 5, type: { identifier: "S" } })).toMatchObject({
      kind: "service",
      notesPath: "/service/tickets/5/notes",
    });
    expect(linkedTicketPath({ objectId: 6, type: { identifier: "P" } })).toMatchObject({
      kind: "project",
      notesPath: "/project/tickets/6/notes",
    });
    expect(linkedTicketPath({ objectId: 7, type: { identifier: "N", name: "Meeting" } })).toBeNull();
    expect(linkedTicketPath({ type: { identifier: "S" } })).toBeNull();
  });
});

describe("cw_delete_schedule_entry", () => {
  it("is registered as a destructive write that needs a reason and takes confirm", async () => {
    const tools = (
      await mcp<{ tools: { name: string; annotations?: Rec; inputSchema: { required?: string[]; properties: Rec } }[] }>(
        "tools/list",
        {},
      )
    ).result.tools;
    const tool = tools.find((t) => t.name === "cw_delete_schedule_entry")!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(["confirm", "id", "reason"]);
    expect(tool.inputSchema.required?.sort()).toEqual(["id", "reason"]);
  });

  it("makes no write without confirm: true and returns the plan with the note text", async () => {
    const cw = fakeConnectWise({ entries: { 501: entry() } });

    const result = await call("cw_delete_schedule_entry", { id: 501, reason: "Booked on the wrong ticket" });

    expect(result.isError).toBe(true);
    expect(cw.calls.some((c) => c.method !== "GET")).toBe(false);
    const plan = body(result) as { deleted: boolean; note: { text: string; ticketId: number } };
    expect(plan.deleted).toBe(false);
    expect(plan.note.ticketId).toBe(77);
    // 2999-01-01 02:00Z is 10:00 in Perth.
    expect(plan.note.text).toContain("01/01/2999 10:00 to 01/01/2999 12:00 Perth time (AWST)");
    expect(plan.note.text).toContain("Member: Stephan Jenner (SJenner)");
    expect(plan.note.text).toContain("Reason: Booked on the wrong ticket");
    expect(cw.state.entries[501]).toBeDefined();
  });

  it.each([
    ["its name when it has one", { id: 4, name: "Service", identifier: "S" }, "Service"],
    ["the ticket kind when it has only an identifier S", { id: 4, identifier: "S" }, "service"],
    ["the ticket kind when it has only an identifier P", { id: 5, identifier: "P" }, "project"],
  ])("shows the booking type in the plan from %s", async (_label, type, expected) => {
    fakeConnectWise({ entries: { 501: entry({ type }) } });

    const result = await call("cw_delete_schedule_entry", { id: 501, reason: "Booked on the wrong ticket" });

    expect((body(result) as { entry: { type: string | null } }).entry.type).toBe(expected);
  });

  it("falls back to the identifier for a type that does not link to a ticket", async () => {
    fakeConnectWise({ entries: { 501: entry({ type: { id: 9, identifier: "N" } }) } });

    const result = await call("cw_delete_schedule_entry", { id: 501, reason: "Wrong booking", confirm: true });

    expect(body(result)).toMatchObject({ refused: true, entry: { type: "N" } });
  });

  it("refuses a short reason before any request", async () => {
    const cw = fakeConnectWise({ entries: { 501: entry() } });
    const result = await call("cw_delete_schedule_entry", { id: 501, reason: "no", confirm: true });
    expect(result.isError).toBe(true);
    expect(cw.fetchMock).not.toHaveBeenCalled();
  });

  it("deletes a future, not-done entry, adds the internal note and reads both back", async () => {
    const cw = fakeConnectWise({ entries: { 501: entry() } });

    const result = await call("cw_delete_schedule_entry", {
      id: 501,
      reason: "Booked on the wrong ticket",
      confirm: true,
    });

    expect(result.isError).not.toBe(true);
    const out = body(result) as {
      deleted: boolean;
      verified: boolean;
      entryGone: boolean;
      note: { added: boolean; readBack: boolean; id: number; ticketId: number };
    };
    expect(out).toMatchObject({ deleted: true, verified: true, entryGone: true });
    expect(out.note).toMatchObject({ added: true, readBack: true, ticketId: 77 });

    // Delete first, then the note, then the read backs.
    expect(cw.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /schedule/entries/501",
      "GET /time/entries",
      "DELETE /schedule/entries/501",
      "POST /service/tickets/77/notes",
      "GET /schedule/entries/501",
      "GET /service/tickets/77/notes",
    ]);
    const post = cw.calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({ internalAnalysisFlag: true });
    expect(cw.state.entries[501]).toBeUndefined();
  });

  it("checks for time against the booking by member, ticket and window", async () => {
    const cw = fakeConnectWise({ entries: { 501: entry() } });
    await call("cw_delete_schedule_entry", { id: 501, reason: "Wrong booking", confirm: true });

    const timeQuery = cw.calls.find((c) => c.path === "/time/entries")!;
    expect(timeQuery.query.get("conditions")).toBe(
      "chargeToId = 77 and member/id = 20 and timeStart >= [2999-01-01T02:00:00Z] and timeStart <= [2999-01-01T04:00:00Z]",
    );
  });

  it.each([
    ["a done entry", entry({ doneFlag: true }), /marked done/],
    ["an entry that has started", entry({ dateStart: iso(-HOUR), dateEnd: iso(HOUR) }), /not in the future/],
    ["an entry with no start", entry({ dateStart: undefined }), /no start date/],
    ["a meeting with no ticket", entry({ type: { id: 9, name: "Meeting", identifier: "N" } }), /no ticket to carry the note/],
  ])("refuses %s and writes nothing", async (_label, record, pattern) => {
    const cw = fakeConnectWise({ entries: { 501: record } });

    const result = await call("cw_delete_schedule_entry", { id: 501, reason: "Wrong booking", confirm: true });

    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({ deleted: false, refused: true });
    expect(String(body(result).message)).toMatch(pattern);
    expect(cw.calls.some((c) => c.method !== "GET")).toBe(false);
    expect(cw.state.entries[501]).toBeDefined();
  });

  it("refuses an entry with time logged against it", async () => {
    const cw = fakeConnectWise({ entries: { 501: entry() }, timeEntries: [{ id: 9001 }] });

    const result = await call("cw_delete_schedule_entry", { id: 501, reason: "Wrong booking", confirm: true });

    expect(result.isError).toBe(true);
    expect(String(body(result).message)).toMatch(/time logged against it \(time entry 9001\)/);
    expect(cw.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("reports an entry that is not there", async () => {
    fakeConnectWise({});
    const result = await call("cw_delete_schedule_entry", { id: 404, reason: "Wrong booking", confirm: true });
    expect(result.isError).toBe(true);
    expect(String(body(result).message)).toMatch(/was not found/);
  });

  it("puts the note on a project ticket for a project entry", async () => {
    const cw = fakeConnectWise({
      entries: { 502: entry({ id: 502, objectId: 88, type: { id: 5, name: "Project", identifier: "P" } }) },
    });

    const result = await call("cw_delete_schedule_entry", { id: 502, reason: "Wrong booking", confirm: true });

    expect(body(result)).toMatchObject({ deleted: true, verified: true });
    expect(cw.calls.some((c) => c.method === "POST" && c.path === "/project/tickets/88/notes")).toBe(true);
  });

  it("says the delete happened and gives the note text when the note cannot be added", async () => {
    const cw = fakeConnectWise({ entries: { 501: entry() }, failNoteOn: [77] });

    const result = await call("cw_delete_schedule_entry", { id: 501, reason: "Wrong booking", confirm: true });

    expect(result.isError).toBe(true);
    const out = body(result) as { deleted: boolean; verified: boolean; warning: string; note: { text: string; added: boolean } };
    expect(out).toMatchObject({ deleted: true, verified: false });
    expect(out.note.added).toBe(false);
    expect(out.warning).toMatch(/Add the note text above to the ticket by hand/);
    expect(cw.state.entries[501]).toBeUndefined();
  });
});

describe("cw_merge_tickets", () => {
  function mergeWorld(extra: Partial<FakeState> = {}) {
    return fakeConnectWise({
      tickets: { 10: ticket(10), 11: ticket(11), 12: ticket(12) },
      companies: { 250: { id: 250, name: "Future Logic HQ", status: { id: 1, name: "Active" } } },
      statuses: {
        33: [
          { id: 1, name: "New", closedStatus: false },
          { id: 9, name: "Closed", closedStatus: true },
          { id: 8, name: "Old closed", closedStatus: true, inactive: true },
        ],
      },
      ...extra,
    });
  }

  it("is registered as a destructive write with confirm", async () => {
    const tools = (
      await mcp<{ tools: { name: string; annotations?: Rec; inputSchema: { properties: Rec } }[] }>("tools/list", {})
    ).result.tools;
    const tool = tools.find((t) => t.name === "cw_merge_tickets")!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(["childIds", "confirm", "parentId", "statusId"]);
  });

  it("makes no write without confirm: true and returns the plan with the board's closed status", async () => {
    const cw = mergeWorld();

    const result = await call("cw_merge_tickets", { parentId: 10, childIds: [11, 12] });

    expect(result.isError).toBe(true);
    expect(cw.calls.some((c) => c.method !== "GET")).toBe(false);
    expect(body(result)).toMatchObject({
      merged: false,
      plan: {
        parent: { id: 10 },
        children: [{ id: 11 }, { id: 12 }],
        status: { id: 9, name: "Closed" },
      },
    });
  });

  it("merges to the board's one closed status, notes the parent and reads everything back", async () => {
    const cw = mergeWorld();

    const result = await call("cw_merge_tickets", { parentId: 10, childIds: [11, 12], confirm: true });

    expect(result.isError).not.toBe(true);
    const out = body(result) as {
      merged: boolean;
      verified: boolean;
      children: { id: number; closed: boolean; closedWithStatus: boolean }[];
      parent: { closed: boolean };
      note: { added: boolean; readBack: boolean; text: string };
    };
    expect(out).toMatchObject({ merged: true, verified: true });
    expect(out.children).toEqual([
      expect.objectContaining({ id: 11, closed: true, closedWithStatus: true }),
      expect.objectContaining({ id: 12, closed: true, closedWithStatus: true }),
    ]);
    expect(out.parent.closed).toBe(false);
    expect(out.note).toMatchObject({ added: true, readBack: true });
    expect(out.note.text).toContain('#11 "Ticket 11"');
    expect(out.note.text).toContain('#12 "Ticket 12"');

    const merge = cw.calls.find((c) => c.path === "/service/tickets/10/merge")!;
    expect(merge.method).toBe("POST");
    expect(merge.body).toEqual({ mergeTicketIds: [11, 12], status: { id: 9 } });
    const noteCall = cw.calls.find((c) => c.method === "POST" && c.path === "/service/tickets/10/notes")!;
    expect(noteCall.body).toMatchObject({ internalAnalysisFlag: true });
    // The note comes after the merge.
    expect(cw.calls.indexOf(noteCall)).toBeGreaterThan(cw.calls.indexOf(merge));
  });

  it("names a status the caller passed, in the plan, the result and the parent note", async () => {
    const cw = mergeWorld();

    const plan = await call("cw_merge_tickets", { parentId: 10, childIds: [11, 12], statusId: 9 });
    expect(body(plan)).toMatchObject({ plan: { status: { id: 9, name: "Closed" } } });

    const result = await call("cw_merge_tickets", { parentId: 10, childIds: [11, 12], statusId: 9, confirm: true });

    const out = body(result) as { status: { id: number; name: string | null }; note: { text: string } };
    expect(out.status).toEqual({ id: 9, name: "Closed" });
    expect(out.note.text).toContain('closed with the status "Closed"');
    expect(out.note.text).not.toMatch(/status id \d+/);
    expect(cw.calls.find((c) => c.path === "/service/tickets/10/merge")!.body).toEqual({
      mergeTicketIds: [11, 12],
      status: { id: 9 },
    });
  });

  it("names the passed status from the board even when it is not the board's closed one", async () => {
    mergeWorld();

    const result = await call("cw_merge_tickets", { parentId: 10, childIds: [11], statusId: 1, confirm: true });

    const out = body(result) as { note: { text: string } };
    expect(out.note.text).toContain('closed with the status "New"');
  });

  it("falls back to the id when the passed status is not on the children's board", async () => {
    mergeWorld();

    const result = await call("cw_merge_tickets", { parentId: 10, childIds: [11], statusId: 77, confirm: true });

    const out = body(result) as { status: { id: number; name: string | null }; note: { text: string } };
    expect(out.status).toEqual({ id: 77, name: null });
    expect(out.note.text).toContain("closed with the status id 77");
  });

  it("stops and lists the statuses when the board has more than one closed status", async () => {
    const cw = mergeWorld({
      statuses: {
        33: [
          { id: 9, name: "Closed", closedStatus: true },
          { id: 10, name: "Closed - merged", closedStatus: true },
        ],
      },
    });

    const result = await call("cw_merge_tickets", { parentId: 10, childIds: [11], confirm: true });

    expect(result.isError).toBe(true);
    const out = body(result) as { statusNeeded: { reason: string; statuses: { id: number }[] } };
    expect(out.statusNeeded.reason).toMatch(/more than one closed status/);
    expect(out.statusNeeded.statuses.map((s) => s.id)).toEqual([9, 10]);
    expect(cw.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("stops and lists every status when none is marked closed", async () => {
    mergeWorld({ statuses: { 33: [{ id: 1, name: "New" }, { id: 2, name: "Done" }] } });
    const result = await call("cw_merge_tickets", { parentId: 10, childIds: [11], confirm: true });
    const out = body(result) as { statusNeeded: { reason: string; statuses: { id: number }[] } };
    expect(out.statusNeeded.reason).toMatch(/No status on the board is marked closed/);
    expect(out.statusNeeded.statuses).toHaveLength(2);
  });

  it("uses a statusId the caller passes", async () => {
    const cw = mergeWorld({
      statuses: { 33: [{ id: 9, name: "Closed", closedStatus: true }, { id: 10, name: "Merged", closedStatus: true }] },
    });

    const result = await call("cw_merge_tickets", { parentId: 10, childIds: [11], statusId: 10, confirm: true });

    expect(body(result)).toMatchObject({ merged: true });
    expect(cw.calls.find((c) => c.path.endsWith("/merge"))!.body).toEqual({
      mergeTicketIds: [11],
      status: { id: 10 },
    });
    // The caller's status is used as given, not replaced by the board's closed status. The
    // board is read only to give that status its name, and that read is a GET.
    const statusReads = cw.calls.filter((c) => c.path.includes("/statuses"));
    expect(statusReads.length).toBeGreaterThan(0);
    expect(statusReads.every((c) => c.method === "GET")).toBe(true);
  });

  it.each([
    ["the parent among the children", { parentId: 10, childIds: [10, 11] }, {}, /cannot also be a child/],
    ["a ticket that does not exist", { parentId: 10, childIds: [11, 404] }, {}, /404 was not found/],
  ])("refuses %s with no write", async (_label, args, _world, pattern) => {
    const cw = mergeWorld();
    const result = await call("cw_merge_tickets", { ...args, confirm: true });
    expect(result.isError).toBe(true);
    expect(String(body(result).message)).toMatch(pattern);
    expect(cw.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("refuses a closed ticket and a ticket from another company", async () => {
    const cw = mergeWorld({
      tickets: {
        10: ticket(10),
        11: ticket(11, { closedFlag: true }),
        12: ticket(12, { company: { id: 300, name: "Some Client" } }),
      },
    });

    const closed = await call("cw_merge_tickets", { parentId: 10, childIds: [11], confirm: true });
    expect(String(body(closed).message)).toMatch(/already closed/);

    const other = await call("cw_merge_tickets", { parentId: 10, childIds: [12], confirm: true });
    expect(String(body(other).message)).toMatch(/different company/);
    expect(cw.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("names the company and its status when the parent's company is inactive", async () => {
    const cw = mergeWorld({
      inactiveCompanies: [250],
      companies: { 250: { id: 250, name: "Future Logic HQ", status: { id: 3, name: "Inactive" } } },
    });

    const result = await call("cw_merge_tickets", { parentId: 10, childIds: [11], confirm: true });

    expect(result.isError).toBe(true);
    const out = body(result) as { reason: string; message: string };
    expect(out.reason).toBe("inactive-company");
    expect(out.message).toContain("Future Logic HQ (id 250)");
    expect(out.message).toContain('"Inactive"');
    expect(cw.state.tickets[11].closedFlag).toBe(false);
  });
});

describe("inactive company (D12)", () => {
  const inactiveWorld = () =>
    fakeConnectWise({
      tickets: { 20: ticket(20, { company: { id: 400, name: "Catchall" } }) },
      companies: {
        400: { id: 400, name: "Catchall", status: { id: 3, name: "Inactive" } },
        250: { id: 250, name: "Future Logic HQ", status: { id: 1, name: "Active" } },
      },
      inactiveCompanies: [400],
    });
  const rename = [{ op: "replace", path: "summary", value: "Renamed" }];

  it("recognises the ConnectWise refusal and a company operation", () => {
    expect(touchesCompany([{ path: "company/id" }])).toBe(true);
    expect(touchesCompany([{ path: "/company" }])).toBe(true);
    expect(touchesCompany([{ path: "summary" }, { path: "owner/id" }])).toBe(false);
    expect(isInactiveCompanyError(new Error(INACTIVE_MESSAGE))).toBe(false);
  });

  it("cw_update_ticket refuses, names the company and its status, and changes nothing", async () => {
    const cw = inactiveWorld();

    const result = await call("cw_update_ticket", { id: 20, operations: rename });

    expect(result.isError).toBe(true);
    const out = body(result) as { reason: string; message: string; company: Rec; companyStatus: Rec };
    expect(out.reason).toBe("inactive-company");
    expect(out.message).toContain("Catchall (id 400)");
    expect(out.message).toContain('"Inactive"');
    expect(out.message).toContain("newCompanyId and confirm: true");
    expect(out.company).toMatchObject({ id: 400, name: "Catchall" });
    expect(out.companyStatus).toMatchObject({ id: 3, name: "Inactive" });
    expect(cw.state.tickets[20].summary).toBe("Ticket 20");
    // One refused patch. No second attempt.
    expect(cw.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  it("does not move the ticket when newCompanyId is passed without confirm: true", async () => {
    const cw = inactiveWorld();

    const result = await call("cw_update_ticket", { id: 20, operations: rename, newCompanyId: 250 });

    expect(result.isError).toBe(true);
    expect(String(body(result).message)).toMatch(/confirm: true was not/);
    expect((cw.state.tickets[20].company as Rec).id).toBe(400);
    expect(cw.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  it("saves the patch and the move together with newCompanyId and confirm: true", async () => {
    const cw = inactiveWorld();

    const result = await call("cw_update_ticket", {
      id: 20,
      operations: rename,
      newCompanyId: 250,
      confirm: true,
      lean: true,
    });

    expect(result.isError).not.toBe(true);
    expect(body(result)).toMatchObject({
      id: 20,
      summary: "Renamed",
      companyMoved: { from: { id: 400, name: "Catchall" }, to: { id: 250 } },
    });
    const patches = cw.calls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(2);
    expect(patches[1].body).toEqual([...rename, { op: "replace", path: "company/id", value: 250 }]);
    expect((cw.state.tickets[20].company as Rec).id).toBe(250);
  });

  it("says so when the company to move to is also inactive", async () => {
    const cw = inactiveWorld();
    cw.state.inactiveCompanies.push(250);

    const result = await call("cw_update_ticket", { id: 20, operations: rename, newCompanyId: 250, confirm: true });

    expect(result.isError).toBe(true);
    expect(String(body(result).message)).toMatch(/company it was to move to, Future Logic HQ.*also in a status/);
    expect((cw.state.tickets[20].company as Rec).id).toBe(400);
  });

  it("does not move a ticket's company by a patch operation without confirm: true", async () => {
    const cw = inactiveWorld();
    cw.state.tickets[21] = ticket(21);

    const result = await call("cw_update_ticket", {
      id: 21,
      operations: [{ op: "replace", path: "company/id", value: 300 }],
    });

    expect(result.isError).toBe(true);
    expect(String(body(result).message)).toMatch(/changes the ticket's company/);
    expect(cw.calls).toHaveLength(0);
  });

  it("leaves an ordinary patch alone: no confirm needed, no extra reads", async () => {
    const cw = inactiveWorld();
    cw.state.tickets[21] = ticket(21);

    const result = await call("cw_update_ticket", { id: 21, operations: rename });

    expect(result.isError).not.toBe(true);
    expect(cw.calls.map((c) => c.method)).toEqual(["PATCH"]);
  });

  it("cw_bulk_update_tickets gives the refused ticket an error row that names company and status", async () => {
    const cw = inactiveWorld();
    cw.state.tickets[21] = ticket(21);

    const result = await call("cw_bulk_update_tickets", { ids: [20, 21], operations: rename, confirm: true });

    const rows = (body(result) as { rows: Rec[] }).rows;
    expect(rows[0]).toMatchObject({ id: 20, success: false, reason: "inactive-company" });
    expect(String(rows[0].error)).toContain("Catchall (id 400)");
    expect(String(rows[0].error)).toContain('"Inactive"');
    expect(rows[1]).toMatchObject({ id: 21, success: true, verified: true });
  });

  it("cw_create_ticket names the company and its status", async () => {
    inactiveWorld();

    const result = await call("cw_create_ticket", { summary: "New", companyId: 400 });

    expect(result.isError).toBe(true);
    const out = body(result) as { reason: string; message: string };
    expect(out.reason).toBe("inactive-company");
    expect(out.message).toContain("Catchall (id 400)");
    expect(out.message).toContain("Create the ticket with a company that is active");
  });

  it("passes any other error through unchanged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ code: "InvalidObject", message: "Summary is required" }, 400)),
    );

    const result = await mcp("tools/call", { name: "cw_update_ticket", arguments: { id: 1, operations: rename } });

    expect(JSON.stringify(result)).toContain("Summary is required");
    expect(JSON.stringify(result)).not.toContain("inactive-company");
  });
});

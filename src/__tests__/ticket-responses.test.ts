/**
 * Tests for WS3 Group 1, ticket responses: the lean option on cw_get_ticket and
 * cw_update_ticket (D13), cw_bulk_update_tickets, the ticket card reading
 * structuredContent (WYRE-AI #105), and the note email mapping.
 *
 * The tools are driven through the Worker's MCP endpoint in gateway mode. A
 * small in-test fake stands in for the ConnectWise endpoints these tools call:
 * it applies a JSON Patch to a ticket and returns what it holds, so the read
 * backs in the tools are exercised against state, not against a canned reply.
 * This is test infrastructure only. Nothing here is a live ConnectWise result.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../worker.js";
import { cardFromResult, extractCard } from "../card-payload.js";
import { TICKET_CARD_HTML } from "../generated/ticket-card-html.js";
import {
  checkPatchAgainstRecord,
  operationsMissingValue,
  toLeanTicket,
} from "../tools/ticket-lean.js";
import { buildTicketNoteBody, planNoteEmail } from "../tools/note-payload.js";

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
  structuredContent?: Record<string, unknown>;
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
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A ticket as Manage returns it: many fields, and a nested record per reference. */
function fullTicket(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  const ref = (refId: number, name: string, extra: Record<string, unknown> = {}) => ({
    id: refId,
    name,
    _info: { board_href: `https://api.example/v4_6_release/apis/3.0/x/${refId}` },
    ...extra,
  });
  return {
    id,
    summary: `Test ticket ${id}`,
    recordType: "ServiceTicket",
    board: ref(33, "Service Desk"),
    status: ref(5, "New"),
    workRole: ref(1, "Engineer"),
    workType: ref(2, "Remote"),
    company: ref(250, "Future Logic HQ", { identifier: "FLHQ" }),
    site: ref(11, "Main Office"),
    siteName: "Main Office",
    addressLine1: "1 Test Street",
    city: "Perth",
    stateIdentifier: "WA",
    zip: "6000",
    country: ref(12, "Australia"),
    contact: ref(9, "Test Contact"),
    contactName: "Test Contact",
    contactPhoneNumber: "0400000000",
    contactEmailAddress: "test.contact@example.com",
    type: ref(3, "Request"),
    subType: ref(4, "General"),
    item: ref(6, "Other"),
    team: ref(7, "Support"),
    owner: ref(20, "Stephan Jenner", { identifier: "SJenner" }),
    priority: ref(8, "Priority 3"),
    serviceLocation: ref(9, "Remote"),
    source: ref(10, "Email"),
    requiredDate: "2026-10-20T00:00:00Z",
    budgetHours: 0,
    opportunity: null,
    agreement: ref(14, "Managed Services"),
    severity: "Medium",
    impact: "Medium",
    allowAllClientsPortalView: false,
    customerUpdatedFlag: false,
    automaticEmailContactFlag: false,
    automaticEmailResourceFlag: true,
    automaticEmailCcFlag: false,
    automaticEmailCc: null,
    initialDescription: "A ticket made for a test.",
    initialInternalAnalysis: "",
    initialResolution: "",
    contactEmailLookup: "test.contact@example.com",
    processNotifications: true,
    skipCallback: false,
    closedDate: null,
    closedBy: null,
    closedFlag: false,
    actualHours: 0,
    approved: true,
    estimatedExpenseCost: 0,
    estimatedExpenseRevenue: 0,
    estimatedProductCost: 0,
    estimatedProductRevenue: 0,
    estimatedTimeCost: 0,
    estimatedTimeRevenue: 0,
    billingMethod: "ActualRates",
    billingAmount: 0,
    hourlyRate: 0,
    subBillingMethod: "ActualRates",
    subBillingAmount: 0,
    subDateAccepted: null,
    dateResolved: null,
    dateResplan: null,
    dateResponded: null,
    resolveMinutes: 0,
    resPlanMinutes: 0,
    respondMinutes: 0,
    isInSla: true,
    knowledgeBaseCategoryId: 0,
    knowledgeBaseSubCategoryId: 0,
    allowAllClientsPortalViewFlag: false,
    resources: "SJenner",
    parentTicketId: null,
    hasChildTicket: false,
    hasMergedChildTicketFlag: false,
    billTime: "Billable",
    billExpenses: "Billable",
    billProducts: "Billable",
    predecessorType: null,
    predecessorId: null,
    predecessorClosedFlag: false,
    lagDays: 0,
    lagNonworkingDaysFlag: false,
    estimatedStartDate: null,
    duration: 0,
    location: ref(15, "Perth"),
    department: ref(16, "Services"),
    mobileGuid: "00000000-0000-0000-0000-000000000000",
    currency: { id: 1, symbol: "$", currencyCode: "AUD", name: "Australian Dollar" },
    customFields: [{ id: 1, caption: "Region", type: "Text", entryMethod: "EntryField", value: null }],
    _info: {
      lastUpdated: "2026-10-12T05:00:00Z",
      updatedBy: "SJenner",
      dateEntered: "2026-10-12T04:00:00Z",
      enteredBy: "SJenner",
      activities_href: "https://api.example/x",
      scheduleentries_href: "https://api.example/x",
      documents_href: "https://api.example/x",
      configurations_href: "https://api.example/x",
      tasks_href: "https://api.example/x",
      notes_href: "https://api.example/x",
      products_href: "https://api.example/x",
      timeentries_href: "https://api.example/x",
      expenseEntries_href: "https://api.example/x",
    },
    ...over,
  };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

interface FakeOptions {
  /** Ticket ids whose PATCH answers 400. */
  failPatch?: number[];
  /** Ticket ids whose note POST answers 500. */
  failNote?: number[];
  /** Fail every PATCH that follows the first one on the ticket (a restore). */
  failSecondPatch?: boolean;
}

/** Fake ConnectWise: tickets by id, JSON Patch applied to state, notes echoed with an id. */
function fakeConnectWise(tickets: Record<number, Record<string, unknown>>, options: FakeOptions = {}) {
  const calls: Call[] = [];
  const patchCount: Record<number, number> = {};
  let noteId = 9000;

  const apply = (record: Record<string, unknown>, operations: { op: string; path: string; value?: unknown }[]) => {
    for (const operation of operations) {
      const segments = operation.path.split("/").filter(Boolean);
      let cursor = record;
      for (const segment of segments.slice(0, -1)) {
        cursor[segment] = (cursor[segment] as Record<string, unknown>) ?? {};
        cursor = cursor[segment] as Record<string, unknown>;
      }
      const last = segments[segments.length - 1];
      if (operation.op === "remove") delete cursor[last];
      else cursor[last] = operation.value;
    }
  };

  const fetchMock = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const path = new URL(String(url)).pathname.replace("/v4_6_release/apis/3.0", "");
    const method = String(init.method ?? "GET");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });

    const ticketMatch = path.match(/^\/service\/tickets\/(\d+)$/);
    const noteMatch = path.match(/^\/service\/tickets\/(\d+)\/notes$/);

    if (ticketMatch) {
      const id = Number(ticketMatch[1]);
      const ticket = tickets[id];
      if (!ticket) return jsonResponse({ code: "NotFound", message: "Not found" }, 404);
      if (method === "GET") return jsonResponse(ticket);
      if (method === "PATCH") {
        patchCount[id] = (patchCount[id] ?? 0) + 1;
        if (options.failPatch?.includes(id)) {
          return jsonResponse({ code: "InvalidObject", message: "Patch refused" }, 400);
        }
        if (options.failSecondPatch && patchCount[id] >= 2) {
          return jsonResponse({ code: "ServerError", message: "boom" }, 500);
        }
        apply(ticket, body);
        return jsonResponse(ticket);
      }
    }

    if (noteMatch && method === "POST") {
      const id = Number(noteMatch[1]);
      if (options.failNote?.includes(id)) return jsonResponse({ code: "ServerError", message: "boom" }, 500);
      return jsonResponse({ id: noteId++, ticketId: id, ...(body as object) });
    }

    return jsonResponse({ code: "NotFound", message: `Unexpected ${method} ${path}` }, 404);
  });

  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock, tickets };
}

afterEach(() => vi.unstubAllGlobals());

describe("toLeanTicket", () => {
  it("keeps only id, summary, board, status, owner, company and _info.lastUpdated", () => {
    const lean = toLeanTicket(fullTicket(77));
    expect(Object.keys(lean).sort()).toEqual(
      ["_info", "board", "company", "id", "owner", "status", "summary"].sort(),
    );
    expect(lean).toEqual({
      id: 77,
      summary: "Test ticket 77",
      board: { id: 33, name: "Service Desk" },
      status: { id: 5, name: "New" },
      owner: { id: 20, name: "Stephan Jenner", identifier: "SJenner" },
      company: { id: 250, name: "Future Logic HQ", identifier: "FLHQ" },
      _info: { lastUpdated: "2026-10-12T05:00:00Z" },
    });
  });

  it("gives every key a value when Manage omits a field", () => {
    expect(toLeanTicket({ id: 7 })).toEqual({
      id: 7,
      summary: null,
      board: null,
      status: null,
      owner: null,
      company: null,
      _info: { lastUpdated: null },
    });
    expect(toLeanTicket(null).id).toBeNull();
  });

  it("is a small fraction of a full record (fixture, not a live measurement)", () => {
    const full = JSON.stringify(fullTicket(77), null, 2).length;
    const lean = JSON.stringify(toLeanTicket(fullTicket(77)), null, 2).length;
    expect(lean).toBeLessThan(full / 5);
  });
});

describe("checkPatchAgainstRecord", () => {
  const record = { summary: "New title", status: { id: 7, name: "Closed" }, owner: { id: 20 } };

  it("passes values the record holds, including nested paths", () => {
    expect(
      checkPatchAgainstRecord(record, [
        { op: "replace", path: "summary", value: "New title" },
        { op: "replace", path: "status/id", value: 7 },
        { op: "replace", path: "owner", value: { id: 20 } },
      ]),
    ).toEqual({ mismatches: [], unchecked: [] });
  });

  it("reports a value that did not stick", () => {
    expect(
      checkPatchAgainstRecord(record, [{ op: "replace", path: "status/id", value: 9 }]).mismatches,
    ).toEqual(["status/id"]);
  });

  it("reports a path the record does not carry as unchecked, not as a pass", () => {
    expect(
      checkPatchAgainstRecord(record, [{ op: "replace", path: "budgetHours", value: 2 }]),
    ).toEqual({ mismatches: [], unchecked: ["budgetHours"] });
  });

  it("expects a removed field to read back absent", () => {
    expect(checkPatchAgainstRecord(record, [{ op: "remove", path: "owner" }]).mismatches).toEqual([
      "owner",
    ]);
    expect(checkPatchAgainstRecord(record, [{ op: "remove", path: "contact" }]).mismatches).toEqual([]);
  });

  it("names add and replace operations that carry no value", () => {
    expect(
      operationsMissingValue([
        { op: "replace", path: "summary" },
        { op: "remove", path: "owner" },
        { op: "add", path: "budgetHours", value: 1 },
      ]),
    ).toEqual(["summary"]);
  });
});

describe("cw_get_ticket lean", () => {
  it("returns the lean record in text and structuredContent, with no card and no notes read", async () => {
    const cw = fakeConnectWise({ 77: fullTicket(77) });

    const result = await call("cw_get_ticket", { id: 77, lean: true });

    expect(result.isError).not.toBe(true);
    const expected = toLeanTicket(fullTicket(77));
    expect(result.structuredContent).toEqual(expected);
    expect(json(result)).toEqual(expected);
    expect(result.structuredContent).not.toHaveProperty("_card");
    expect(cw.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /service/tickets/77"]);
  });

  it("returns the full record and a card when lean is not set (D13: opt-in)", async () => {
    fakeConnectWise({ 77: fullTicket(77) });

    const result = await call("cw_get_ticket", { id: 77 });

    expect(result.structuredContent).toMatchObject({ id: 77, recordType: "ServiceTicket" });
    expect(result.structuredContent).toHaveProperty("_card");
  });
});

describe("cw_update_ticket lean", () => {
  const operations = [{ op: "replace", path: "summary", value: "Renamed" }];

  it("returns the lean saved ticket when lean is true", async () => {
    const cw = fakeConnectWise({ 77: fullTicket(77) });

    const result = await call("cw_update_ticket", { id: 77, operations, lean: true });

    expect(json(result)).toMatchObject({ id: 77, summary: "Renamed" });
    expect(Object.keys(json(result)).sort()).toEqual(
      ["_info", "board", "company", "id", "owner", "status", "summary"].sort(),
    );
    expect(cw.calls[0]).toMatchObject({ method: "PATCH", path: "/service/tickets/77", body: operations });
  });

  it("returns the full saved ticket by default", async () => {
    fakeConnectWise({ 77: fullTicket(77) });

    const result = await call("cw_update_ticket", { id: 77, operations });

    expect(json(result)).toMatchObject({ id: 77, summary: "Renamed", recordType: "ServiceTicket" });
  });

  it("makes the lean response far smaller than the full one (fixture, not a live measurement)", async () => {
    fakeConnectWise({ 77: fullTicket(77) });
    const full = (await call("cw_update_ticket", { id: 77, operations })).content[0].text.length;
    const lean = (await call("cw_update_ticket", { id: 77, operations, lean: true })).content[0].text
      .length;
    expect(lean).toBeLessThan(full / 5);
  });
});

describe("cw_bulk_update_tickets", () => {
  const ownerChange = [{ op: "replace", path: "owner/id", value: 31 }];

  it("is registered as a write tool that takes confirm", async () => {
    const tools = (await mcp<{ tools: { name: string; annotations?: Record<string, unknown>; inputSchema: { required?: string[]; properties: Record<string, unknown> } }[] }>("tools/list", {})).result.tools;
    const tool = tools.find((entry) => entry.name === "cw_bulk_update_tickets")!;
    expect(tool).toBeDefined();
    expect(tool.annotations).toMatchObject({ readOnlyHint: false });
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(
      ["confirm", "ids", "note", "operations"].sort(),
    );
    expect(tool.inputSchema.required?.sort()).toEqual(["ids", "operations"]);
  });

  it("makes no request without confirm: true and returns the plan", async () => {
    const cw = fakeConnectWise({ 1: fullTicket(1), 2: fullTicket(2) });

    const result = await call("cw_bulk_update_tickets", {
      ids: [1, 2],
      operations: ownerChange,
      note: "Reassigned in the board review",
    });

    expect(result.isError).toBe(true);
    expect(cw.fetchMock).not.toHaveBeenCalled();
    expect(json(result)).toMatchObject({
      saved: false,
      ticketCount: 2,
      ids: [1, 2],
      planned: ownerChange,
      note: "Reassigned in the board review",
    });
  });

  it("changes five tickets, returns one lean row each, and isolates one forced failure", async () => {
    const tickets = Object.fromEntries([101, 102, 103, 104, 105].map((id) => [id, fullTicket(id)]));
    const cw = fakeConnectWise(tickets, { failPatch: [103] });

    const result = await call("cw_bulk_update_tickets", {
      ids: [101, 102, 103, 104, 105],
      operations: ownerChange,
      confirm: true,
    });

    const body = json(result) as {
      requested: number;
      succeeded: number;
      failed: number;
      rows: Array<Record<string, unknown>>;
    };
    expect(body).toMatchObject({ requested: 5, succeeded: 4, failed: 1 });
    expect(body.rows.map((row) => row.id)).toEqual([101, 102, 103, 104, 105]);
    expect(result.isError).toBe(true);

    const failedRow = body.rows[2];
    expect(failedRow).toMatchObject({ id: 103, success: false });
    expect(String(failedRow.error)).toMatch(/returned 400/);
    expect(failedRow).not.toHaveProperty("ticket");

    for (const row of body.rows.filter((r) => r.success === true)) {
      expect(row.verified).toBe(true);
      const lean = row.ticket as Record<string, unknown>;
      expect(Object.keys(lean).sort()).toEqual(
        ["_info", "board", "company", "id", "owner", "status", "summary"].sort(),
      );
      expect((lean.owner as { id: number }).id).toBe(31);
    }
    // The tickets after the failure were still changed, the failed one was not.
    expect((tickets[104].owner as { id: number }).id).toBe(31);
    expect((tickets[105].owner as { id: number }).id).toBe(31);
    expect((tickets[103].owner as { id: number }).id).toBe(20);
    // Patch, then read back, per ticket. The failed ticket has no read back.
    expect(cw.calls.filter((c) => c.method === "PATCH")).toHaveLength(5);
    expect(cw.calls.filter((c) => c.method === "GET")).toHaveLength(4);
  });

  it("adds the shared note as an internal, unemailed note after each patch", async () => {
    const cw = fakeConnectWise({ 1: fullTicket(1), 2: fullTicket(2) }, { failNote: [2] });

    const result = await call("cw_bulk_update_tickets", {
      ids: [1, 2],
      operations: ownerChange,
      note: "Reassigned in the board review",
      confirm: true,
    });

    const rows = (json(result) as { rows: Array<Record<string, unknown>> }).rows;
    expect(rows[0].note).toEqual({ added: true, id: 9000 });
    expect(rows[1].note).toMatchObject({ added: false });
    expect(rows[1]).toMatchObject({ id: 2, success: true });
    expect(result.isError).toBe(true);

    const noteCall = cw.calls.find((c) => c.method === "POST" && c.path === "/service/tickets/1/notes")!;
    expect(noteCall.body).toEqual({
      text: "Reassigned in the board review",
      internalAnalysisFlag: true,
    });
  });

  it("does not add the note to a ticket whose patch failed", async () => {
    const cw = fakeConnectWise({ 1: fullTicket(1) }, { failPatch: [1] });

    await call("cw_bulk_update_tickets", {
      ids: [1],
      operations: ownerChange,
      note: "Reassigned",
      confirm: true,
    });

    expect(cw.calls.filter((c) => c.path.endsWith("/notes"))).toEqual([]);
  });

  it("reports a value the fresh read does not hold", async () => {
    // A fake that accepts the patch but keeps the old owner.
    const ticket = fullTicket(1);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init: RequestInit = {}) =>
        jsonResponse(init.method === "PATCH" ? { ...ticket, owner: { id: 31 } } : ticket),
      ),
    );

    const result = await call("cw_bulk_update_tickets", {
      ids: [1],
      operations: ownerChange,
      confirm: true,
    });

    const row = (json(result) as { rows: Array<Record<string, unknown>> }).rows[0];
    expect(row).toMatchObject({ success: true, verified: false, mismatches: ["owner/id"] });
    expect(result.isError).toBe(true);
  });

  it("refuses an add or replace with no value before any request", async () => {
    const cw = fakeConnectWise({ 1: fullTicket(1) });

    const result = await call("cw_bulk_update_tickets", {
      ids: [1],
      operations: [{ op: "replace", path: "summary" }],
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/need a value: summary/);
    expect(cw.fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a repeated id, an empty list and a list over the limit", async () => {
    const cw = fakeConnectWise({});
    for (const ids of [[1, 1], [], Array.from({ length: 26 }, (_, i) => i + 1)]) {
      const result = await call("cw_bulk_update_tickets", {
        ids,
        operations: ownerChange,
        confirm: true,
      });
      expect(result.isError).toBe(true);
    }
    expect(cw.fetchMock).not.toHaveBeenCalled();
  });
});

describe("ticket card payload (WYRE-AI #105)", () => {
  const card = {
    id: 77,
    summary: "Server offline",
    status: "New",
    notes: [{ text: "First note", who: "druiz" }],
    noteDefaults: { internalAnalysisFlag: true },
  };

  it("reads the card from structuredContent when text is a plain summary", () => {
    expect(
      cardFromResult({
        content: [{ type: "text", text: "Ticket #77: Server offline (no priority, New)" }],
        structuredContent: { id: 77, summary: "Server offline", _card: card },
      }),
    ).toEqual(card);
  });

  it("falls back to parsing the text when there is no structuredContent", () => {
    expect(
      cardFromResult({ content: [{ type: "text", text: JSON.stringify({ _card: card }) }] }),
    ).toEqual(card);
  });

  it("prefers structuredContent over text", () => {
    const other = { ...card, id: 1, summary: "From text" };
    expect(
      cardFromResult({
        content: [{ type: "text", text: JSON.stringify({ _card: other }) }],
        structuredContent: { _card: card },
      }),
    ).toEqual(card);
  });

  it("returns null for a payload with no usable card", () => {
    expect(cardFromResult({})).toBeNull();
    expect(cardFromResult({ content: [{ type: "text", text: "not json" }] })).toBeNull();
    expect(cardFromResult({ structuredContent: { id: 1 } })).toBeNull();
    expect(extractCard({ _card: { id: 1, summary: "no notes array" } })).toBeNull();
  });

  it("renders from a real cw_get_ticket result", async () => {
    fakeConnectWise({ 77: fullTicket(77) });
    const result = await call("cw_get_ticket", { id: 77 });

    // The text is a summary, as the issue describes. The card is in structuredContent.
    expect(() => JSON.parse(result.content[0].text)).toThrow();
    expect(cardFromResult(result)).toMatchObject({ id: 77, summary: "Test ticket 77" });
  });

  it("ships a rebuilt embedded UI that reads structuredContent", () => {
    expect(TICKET_CARD_HTML).toContain("structuredContent");
    expect(TICKET_CARD_HTML).toContain("_card");
    expect(TICKET_CARD_HTML).toContain("BRAND_INJECT");
  });
});

describe("note email mapping", () => {
  /** A ticket as Manage holds it, with the four recipient fields at known values. */
  function emailTicket(over: Record<string, unknown> = {}) {
    return fullTicket(77, {
      contact: { id: 9, name: "Test Contact" },
      automaticEmailContactFlag: false,
      automaticEmailResourceFlag: true,
      automaticEmailCcFlag: false,
      automaticEmailCc: null,
      ...over,
    });
  }

  describe("buildTicketNoteBody", () => {
    it("never puts the recipient fields on the ServiceNote body", () => {
      const body = buildTicketNoteBody({
        text: "question for the client",
        detailDescriptionFlag: true,
        emailContactFlag: true,
        emailResourceFlag: true,
        emailCcFlag: true,
        emailCc: "billing@example.com",
      });
      expect(body).toEqual({
        text: "question for the client",
        detailDescriptionFlag: true,
        processNotifications: true,
      });
    });

    it("keeps an explicit processNotifications false", () => {
      expect(
        buildTicketNoteBody({ text: "hold", emailContactFlag: true, processNotifications: false })
          .processNotifications,
      ).toBe(false);
    });
  });

  describe("planNoteEmail", () => {
    it("sends nothing when no recipient flag is true", () => {
      const plan = planNoteEmail({ text: "x", emailContactFlag: false }, emailTicket());
      expect(plan).toMatchObject({ willSend: false, via: "none", overrides: [] });
    });

    it("names only the recipients the caller set to true and forces the others off", () => {
      const plan = planNoteEmail({ text: "x", emailContactFlag: true }, emailTicket());
      expect(plan.willSend).toBe(true);
      expect(plan.recipients).toEqual({ contact: true, resources: false, cc: null });
      expect(plan.overrides).toEqual([
        { field: "automaticEmailContactFlag", value: true, original: false },
        { field: "automaticEmailResourceFlag", value: false, original: true },
      ]);
    });

    it("takes the CC address from emailCc, or from the ticket when emailCc is omitted", () => {
      const given = planNoteEmail(
        { text: "x", emailCcFlag: true, emailCc: "a@example.com" },
        emailTicket(),
      );
      expect(given.recipients.cc).toBe("a@example.com");
      const fromTicket = planNoteEmail(
        { text: "x", emailCcFlag: true },
        emailTicket({ automaticEmailCc: "ticket@example.com" }),
      );
      expect(fromTicket.recipients.cc).toBe("ticket@example.com");
    });

    it("refuses a CC flag with no address and a contact flag with no contact", () => {
      expect(planNoteEmail({ text: "x", emailCcFlag: true }, emailTicket()).problems).toEqual([
        "emailCcFlag is true but no address was given in emailCc and the ticket has none",
      ]);
      expect(
        planNoteEmail({ text: "x", emailContactFlag: true }, emailTicket({ contact: null })).problems,
      ).toEqual(["emailContactFlag is true but the ticket has no contact"]);
    });

    it("suppresses delivery on an explicit processNotifications false", () => {
      const plan = planNoteEmail(
        { text: "x", emailContactFlag: true, processNotifications: false },
        emailTicket(),
      );
      expect(plan).toMatchObject({ willSend: false, via: "none" });
    });
  });

  describe("cw_add_ticket_note", () => {
    it("is one POST, with no recipient fields, for a note that sends no mail", async () => {
      const cw = fakeConnectWise({ 77: emailTicket() });

      const result = await call("cw_add_ticket_note", {
        id: 77,
        text: "staff only",
        internalAnalysisFlag: true,
        emailContactFlag: false,
      });

      expect(result.isError).not.toBe(true);
      expect(cw.calls).toHaveLength(1);
      expect(cw.calls[0]).toMatchObject({
        method: "POST",
        path: "/service/tickets/77/notes",
        body: { text: "staff only", internalAnalysisFlag: true },
      });
      expect(json(result).email).toEqual({
        sent: false,
        via: "none",
        reason: "no recipient flag was set to true",
      });
    });

    it("makes no write for a note that will email until confirm is true", async () => {
      const cw = fakeConnectWise({ 77: emailTicket() });

      const result = await call("cw_add_ticket_note", {
        id: 77,
        text: "Please confirm the time",
        detailDescriptionFlag: true,
        emailContactFlag: true,
      });

      expect(result.isError).toBe(true);
      expect(json(result)).toMatchObject({
        saved: false,
        planned: { via: "per-note flags", recipients: { contact: true, resources: false, cc: null } },
      });
      // One read to plan it, and no PATCH or POST.
      expect(cw.calls.map((c) => c.method)).toEqual(["GET"]);
    });

    it("holds the recipient fields for the note, posts it, puts them back and reads them", async () => {
      const ticket = emailTicket();
      const cw = fakeConnectWise({ 77: ticket });

      const result = await call("cw_add_ticket_note", {
        id: 77,
        text: "Please confirm the time",
        detailDescriptionFlag: true,
        emailContactFlag: true,
        confirm: true,
      });

      expect(result.isError).not.toBe(true);
      expect(cw.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        "GET /service/tickets/77",
        "PATCH /service/tickets/77",
        "POST /service/tickets/77/notes",
        "PATCH /service/tickets/77",
        "GET /service/tickets/77",
      ]);
      expect(cw.calls[1].body).toEqual([
        { op: "replace", path: "automaticEmailContactFlag", value: true },
        { op: "replace", path: "automaticEmailResourceFlag", value: false },
      ]);
      expect(cw.calls[2].body).toEqual({
        text: "Please confirm the time",
        detailDescriptionFlag: true,
        processNotifications: true,
      });
      expect(cw.calls[3].body).toEqual([
        { op: "replace", path: "automaticEmailContactFlag", value: false },
        { op: "replace", path: "automaticEmailResourceFlag", value: true },
      ]);

      // The ticket holds what it held before.
      expect(ticket.automaticEmailContactFlag).toBe(false);
      expect(ticket.automaticEmailResourceFlag).toBe(true);

      expect(json(result).email).toEqual({
        sent: true,
        via: "per-note flags",
        recipients: { contact: true, resources: false, cc: null },
        deliveryReported: false,
        ticketFieldsRestored: true,
      });
    });

    it("sets the CC address for the note and puts the old one back", async () => {
      const ticket = emailTicket({ automaticEmailCc: "old@example.com" });
      const cw = fakeConnectWise({ 77: ticket });

      const result = await call("cw_add_ticket_note", {
        id: 77,
        text: "Copying billing",
        emailCcFlag: true,
        emailCc: "billing@example.com",
        confirm: true,
      });

      expect(cw.calls[1].body).toEqual(
        expect.arrayContaining([
          { op: "replace", path: "automaticEmailCcFlag", value: true },
          { op: "replace", path: "automaticEmailCc", value: "billing@example.com" },
        ]),
      );
      expect(ticket.automaticEmailCc).toBe("old@example.com");
      expect(ticket.automaticEmailCcFlag).toBe(false);
      expect(json(result).email).toMatchObject({
        sent: true,
        recipients: { contact: false, resources: false, cc: "billing@example.com" },
      });
    });

    it("refuses before any write when the request cannot be sent as given", async () => {
      const cw = fakeConnectWise({ 77: emailTicket({ contact: null }) });

      const result = await call("cw_add_ticket_note", {
        id: 77,
        text: "x",
        emailContactFlag: true,
        confirm: true,
      });

      expect(result.isError).toBe(true);
      expect(json(result).message).toMatch(/ticket has no contact/);
      expect(cw.calls.map((c) => c.method)).toEqual(["GET"]);
    });

    it("puts the ticket back and says the note was not saved when the note POST fails", async () => {
      const ticket = emailTicket();
      const cw = fakeConnectWise({ 77: ticket }, { failNote: [77] });

      const result = await call("cw_add_ticket_note", {
        id: 77,
        text: "x",
        emailContactFlag: true,
        confirm: true,
      });

      expect(result.isError).toBe(true);
      expect(json(result)).toMatchObject({
        saved: false,
        email: { sent: false, reason: "the note was not saved" },
      });
      expect(ticket.automaticEmailContactFlag).toBe(false);
      expect(ticket.automaticEmailResourceFlag).toBe(true);
      expect(cw.calls.filter((c) => c.method === "PATCH")).toHaveLength(2);
    });

    it("warns, with the original values, when the ticket cannot be put back", async () => {
      fakeConnectWise({ 77: emailTicket() }, { failSecondPatch: true });

      const result = await call("cw_add_ticket_note", {
        id: 77,
        text: "x",
        emailContactFlag: true,
        confirm: true,
      });

      const body = json(result);
      expect(result.isError).toBe(true);
      expect(body.email).toMatchObject({ sent: true, ticketFieldsRestored: false });
      expect(body.warning).toMatch(/could not be confirmed back/);
      expect(body.original).toEqual([
        { field: "automaticEmailContactFlag", original: false },
        { field: "automaticEmailResourceFlag", original: true },
      ]);
    });

    it("does not read or change the ticket on an explicit processNotifications false", async () => {
      const cw = fakeConnectWise({ 77: emailTicket() });

      const result = await call("cw_add_ticket_note", {
        id: 77,
        text: "hold",
        emailContactFlag: true,
        processNotifications: false,
      });

      expect(cw.calls.map((c) => c.method)).toEqual(["POST"]);
      expect(json(result).email).toMatchObject({ sent: false, via: "none" });
    });
  });
});

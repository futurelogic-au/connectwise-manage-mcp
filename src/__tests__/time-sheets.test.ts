/**
 * Tests for the time sheet tools: search, get, approve, reject, reverse, the
 * guided reverse, edit and approve again, and the missing sheets list (D19 to
 * D21).
 *
 * The tools are driven through the Worker's MCP endpoint in gateway mode, so
 * the registration, the input schema and the outbound request are all covered.
 * ConnectWise is a fake that holds time sheets and time entries and moves a
 * sheet between statuses the way the live server was seen to.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../worker.js";
import {
  TIER_ONE_APPROVAL_TYPE,
  diffRecords,
  displayValue,
  findMissingSheets,
  isBusinessDay,
  perthClock,
  toLeanTimeSheet,
  type HolidayData,
} from "../tools/time-sheets.js";

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

type Rec = Record<string, unknown>;

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

function json(result: ToolResult): Rec {
  return JSON.parse(result.content[0].text) as Rec;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

interface FakeState {
  sheets: Record<number, Rec>;
  entries?: Record<number, Rec>;
  audits?: Rec[];
  members?: Rec[];
  calendars?: Rec[];
  /** Holiday dates by holiday list id. */
  holidays?: Record<number, string[]>;
  /** Actions (submit, approve, reject, reverse) that answer 400. */
  failAction?: string[];
  /** Actions that answer 200 and leave the status as it was. */
  ignoreAction?: string[];
  /** Answer a time entry PATCH with 400. */
  failPatch?: boolean;
  /** Fields ConnectWise changes by itself when a time entry is patched. */
  sideEffects?: Rec;
  /** Fields ConnectWise changes on the sheet when it is approved again. */
  sheetSideEffects?: Rec;
  /** Make a sheet reject behave as the live server does: it needs a rejected entry and passes the rest. */
  liveReject?: boolean;
}

const LIVE_REJECT_REFUSAL = {
  code: "InvalidObject",
  message: "timeSheet object is invalid",
  errors: [
    {
      code: "InvalidObject",
      message: "Period 42 / Stephan Jenner cannot be rejected: You must reject the incorrect time entries before rejecting the time sheet.",
      resource: "timeSheet",
      field: "id",
    },
  ],
};

function fakeConnectWise(state: FakeState) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname.replace("/v4_6_release/apis/3.0", "");
    const method = String(init.method ?? "GET");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const query = Object.fromEntries(parsed.searchParams.entries());
    calls.push({ method, path, query, body });
    const firstPage = query.page === undefined || query.page === "1";
    const list = (rows: unknown[]) => jsonResponse(firstPage ? rows : []);
    const notFound = () => jsonResponse({ code: "NotFound", message: "Not found" }, 404);
    let match: RegExpMatchArray | null;

    if (path === "/time/sheets" && method === "GET") return list(Object.values(state.sheets));
    if ((match = path.match(/^\/time\/sheets\/(\d+)$/)) && method === "GET") {
      const sheet = state.sheets[Number(match[1])];
      return sheet ? jsonResponse(sheet) : notFound();
    }
    if (/^\/time\/sheets\/\d+\/audits$/.test(path)) return list(state.audits ?? []);
    if ((match = path.match(/^\/time\/sheets\/(\d+)\/(submit|approve|reject|reverse)$/)) && method === "POST") {
      const sheet = state.sheets[Number(match[1])];
      const action = match[2];
      if (!sheet) return notFound();
      if (state.failAction?.includes(action)) {
        return jsonResponse({ code: "InvalidObject", message: "approvalType is not valid" }, 400);
      }
      if (!state.ignoreAction?.includes(action)) {
        if (action === "approve") Object.assign(sheet, { status: "ApprovedByTierOne" }, state.sheetSideEffects ?? {});
        if (action === "reject") {
          const onSheet = Object.values(state.entries ?? {}).filter((entry) => (entry.timeSheet as Rec | undefined)?.id === sheet.id);
          if (state.liveReject && !onSheet.some((entry) => entry.status === "Rejected")) {
            return jsonResponse(LIVE_REJECT_REFUSAL, 400);
          }
          sheet.status = "Rejected";
          // Seen live: every entry that is not rejected is passed.
          if (state.liveReject) {
            for (const entry of onSheet) {
              if (entry.status !== "Rejected") entry.status = entry.chargeToType === "ProjectTicket" ? "PendingProjectApproval" : "ReadyToBill";
            }
          }
        }
        // Seen live: a reverse un-submits the sheet, and a submit takes no body.
        if (action === "reverse") sheet.status = "Open";
        if (action === "submit") sheet.status = "PendingApproval";
      }
      return jsonResponse({ success: true });
    }
    if (path === "/time/entries" && method === "GET") return list(Object.values(state.entries ?? {}));
    if ((match = path.match(/^\/time\/entries\/(\d+)\/reject$/)) && method === "POST") {
      const entry = state.entries?.[Number(match[1])];
      if (!entry) return notFound();
      if (state.failAction?.includes("entryReject")) return jsonResponse({ code: "InvalidObject", message: "No" }, 400);
      // Seen live: a reject with no comment is refused, and the message names the field.
      if (!(body as Rec | undefined)?.comment) {
        return jsonResponse(
          {
            code: "InvalidObject",
            message: "timeEntryTierUpdate object is invalid",
            errors: [{ code: "MissingRequiredField", message: "The comment field is required.", resource: "timeEntryTierUpdate", field: "comment" }],
          },
          400,
        );
      }
      if (!state.ignoreAction?.includes("entryReject")) entry.status = "Rejected";
      return jsonResponse({ success: true });
    }
    if ((match = path.match(/^\/time\/entries\/(\d+)$/))) {
      const entry = state.entries?.[Number(match[1])];
      if (!entry) return notFound();
      if (method === "GET") return jsonResponse(entry);
      if (method === "PATCH") {
        if (state.failPatch) return jsonResponse({ code: "InvalidObject", message: "Entry is billed" }, 400);
        for (const operation of body as { path: string; value: unknown }[]) entry[operation.path] = operation.value;
        Object.assign(entry, state.sideEffects ?? {});
        return jsonResponse(entry);
      }
    }
    if (path === "/system/members") return list(state.members ?? []);
    if (path === "/schedule/calendars") return list(state.calendars ?? []);
    if ((match = path.match(/^\/schedule\/holidayLists\/(\d+)\/holidays$/))) {
      return list((state.holidays?.[Number(match[1])] ?? []).map((date) => ({ date: `${date}T00:00:00Z` })));
    }
    return jsonResponse({ code: "NotFound", message: `Unexpected ${method} ${path}` }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock, state };
}

/** A time sheet as ConnectWise returns it. The period is two dates at midnight UTC. */
function sheet(id: number, over: Rec = {}): Rec {
  return {
    id,
    member: { id: 147, identifier: "sjenner", name: "Stephan Jenner", _info: { member_href: "x" } },
    year: 2026,
    period: 42,
    dateStart: "2026-10-10T00:00:00Z",
    dateEnd: "2026-10-16T00:00:00Z",
    status: "PendingApproval",
    hours: 31.5,
    deadline: "2026-10-16T16:00:00Z",
    _info: { lastUpdated: "2026-10-13T11:13:53Z", updatedBy: "sjenner" },
    ...over,
  };
}

function entry(id: number, over: Rec = {}): Rec {
  return {
    id,
    member: { id: 147, identifier: "sjenner", name: "Stephan Jenner" },
    company: { id: 250, identifier: "FLHQ", name: "Future Logic" },
    chargeToId: 904995,
    chargeToType: "ServiceTicket",
    timeStart: "2026-10-13T06:05:00Z",
    timeEnd: "2026-10-13T06:50:00Z",
    actualHours: 0.75,
    billableOption: "Billable",
    notes: "Worked on the tool batch",
    workType: { id: 28, name: "> Business Days (830-530)", _info: { workType_href: "a" } },
    hourlyRate: 180,
    timeSheet: { id: 900, name: "2026-10-10 to 2026-10-16", _info: { timeSheet_href: "b" } },
    status: "ApprovedByTierOne",
    _info: { lastUpdated: "2026-10-13T06:50:00Z", updatedBy: "sjenner" },
    ...over,
  };
}

const writes = (calls: Call[]) => calls.filter((entry) => entry.method !== "GET");
const sent = (calls: Call[]) => writes(calls).map((entry) => `${entry.method} ${entry.path}`);

afterEach(() => vi.unstubAllGlobals());

describe("time sheet tools, registration", () => {
  it("registers the reads as read-only and the writes with confirm", async () => {
    const tools = (await mcp<{ tools: ListedTool[] }>("tools/list", {})).result.tools;
    const find = (name: string) => tools.find((tool) => tool.name === name)!;
    for (const name of ["cw_search_time_sheets", "cw_get_time_sheet", "cw_list_missing_time_sheets"]) {
      expect(find(name), name).toBeDefined();
      expect(find(name).annotations, name).toMatchObject({ readOnlyHint: true });
      expect(find(name).inputSchema.properties, name).not.toHaveProperty("confirm");
    }
    for (const name of ["cw_submit_time_sheet", "cw_approve_time_sheet", "cw_reject_time_sheet", "cw_reject_time_entry", "cw_reverse_time_sheet", "cw_edit_approved_time_entry"]) {
      expect(find(name), name).toBeDefined();
      expect(find(name).annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(find(name).inputSchema.properties, name).toHaveProperty("confirm");
    }
    // D20: a reverse needs a reason. D19: no tool lets the caller pick an approval tier.
    expect(find("cw_reverse_time_sheet").inputSchema.required?.sort()).toEqual(["id", "reason"]);
    // ConnectWise refuses an entry reject with no comment, so the reason is required.
    expect(find("cw_reject_time_entry").inputSchema.required?.sort()).toEqual(["id", "reason"]);
    expect(find("cw_edit_approved_time_entry").inputSchema.required?.sort()).toEqual(["operations", "reason", "timeEntryId"]);
    for (const tool of tools.filter((entry) => /time_sheet|approved_time_entry|reject_time_entry/.test(entry.name))) {
      expect(tool.inputSchema.properties, tool.name).not.toHaveProperty("approvalType");
    }
  });
});

describe("cw_search_time_sheets and cw_get_time_sheet", () => {
  it("searches lean, with the period as calendar dates, and builds the filters", async () => {
    const cw = fakeConnectWise({ sheets: { 13818: sheet(13818) } });
    const out = json(
      await call("cw_search_time_sheets", {
        memberIdentifier: "sjenner",
        status: "PendingApproval",
        periodStartFrom: "2026-10-03",
        periodStartTo: "2026-10-10",
      }),
    ) as { count: number; timeSheets: Rec[] };
    expect(out.count).toBe(1);
    expect(out.timeSheets[0]).toEqual({
      id: 13818,
      member: { id: 147, identifier: "sjenner", name: "Stephan Jenner" },
      status: "PendingApproval",
      hours: 31.5,
      dateStart: "2026-10-10",
      dateEnd: "2026-10-16",
      label: "10/10/2026 to 16/10/2026",
      year: 2026,
      period: 42,
      deadline: "2026-10-16T16:00:00Z",
      _info: { lastUpdated: "2026-10-13T11:13:53Z", updatedBy: "sjenner" },
    });
    expect(cw.calls[0].query.conditions).toBe(
      "(member/identifier='sjenner') and (status='PendingApproval') and (dateStart>=[2026-10-03]) and (dateStart<=[2026-10-10])",
    );
    expect(cw.calls[0].query.orderBy).toBe("dateStart desc");
  });

  it("refuses a filter that could break out of the condition, before any request", async () => {
    const cw = fakeConnectWise({ sheets: {} });
    for (const args of [{ memberIdentifier: "a' or id>0 or 'a'='a" }, { status: "Open' or 1=1" }, { periodStartFrom: "13/10/2026" }]) {
      expect((await call("cw_search_time_sheets", args)).isError).toBe(true);
    }
    expect(cw.fetchMock).not.toHaveBeenCalled();
  });

  it("gets a sheet with its audit trail and its entries", async () => {
    const cw = fakeConnectWise({
      sheets: { 900: sheet(900, { status: "ApprovedByTierOne" }) },
      entries: { 1: entry(1) },
      audits: [
        { id: 5, member: { id: 148, identifier: "NColyer-Long" }, message: "audit_time_tier1update_approval", _info: {} },
        { id: 6, member: { id: 148, identifier: "NColyer-Long" }, message: "audit_time_approval_status_change", oldValue: "Pending Approval", newValue: "Approved by Tier 1" },
      ],
    });
    const out = json(await call("cw_get_time_sheet", { id: 900 }));
    expect(out).toMatchObject({
      timeSheet: { id: 900, status: "ApprovedByTierOne", label: "10/10/2026 to 16/10/2026" },
      audits: [
        { id: 5, member: "NColyer-Long", message: "audit_time_tier1update_approval" },
        { id: 6, member: "NColyer-Long", oldValue: "Pending Approval", newValue: "Approved by Tier 1" },
      ],
      entryCount: 1,
      entries: [{ id: 1, actualHours: 0.75, billableOption: "Billable", company: "FLHQ", workType: "> Business Days (830-530)" }],
    });
    const entries = cw.calls.find((entry) => entry.path === "/time/entries")!;
    expect(entries.query.conditions).toBe("timeSheet/id=900");
    expect(writes(cw.calls)).toEqual([]);
  });

  it("leaves the entries out when asked", async () => {
    const cw = fakeConnectWise({ sheets: { 900: sheet(900) } });
    const out = json(await call("cw_get_time_sheet", { id: 900, includeEntries: false }));
    expect(out).not.toHaveProperty("entries");
    expect(cw.calls.some((entry) => entry.path === "/time/entries")).toBe(false);
  });
});

describe("cw_approve_time_sheet (D19)", () => {
  it("writes nothing without confirm: true and returns the plan", async () => {
    const cw = fakeConnectWise({ sheets: { 900: sheet(900) } });
    const result = await call("cw_approve_time_sheet", { id: 900 });
    expect(result.isError).toBe(true);
    expect(json(result)).toMatchObject({
      saved: false,
      planned: { call: "POST /time/sheets/900/approve", approvalType: "Tier1Update" },
      timeSheet: { id: 900, status: "PendingApproval" },
    });
    expect(writes(cw.calls)).toEqual([]);
  });

  it("approves at tier one with the value ConnectWise takes, and reads ApprovedByTierOne back", async () => {
    const cw = fakeConnectWise({ sheets: { 900: sheet(900) } });
    const result = await call("cw_approve_time_sheet", { id: 900, confirm: true });
    expect(result.isError).not.toBe(true);
    expect(json(result)).toMatchObject({
      saved: true,
      verified: true,
      action: "approve",
      statusBefore: "PendingApproval",
      statusAfter: "ApprovedByTierOne",
      timeSheet: { id: 900, status: "ApprovedByTierOne" },
    });
    expect(sent(cw.calls)).toEqual(["POST /time/sheets/900/approve"]);
    // The status a good approval reads is not the value the call takes.
    expect(writes(cw.calls)[0].body).toEqual({ approvalType: "Tier1Update" });
    expect(TIER_ONE_APPROVAL_TYPE).toBe("Tier1Update");
  });

  it.each(["Open", "Rejected", "ApprovedByTierOne", "ApprovedByTierTwo", "Billed"])(
    "refuses a sheet that is %s, with nothing written",
    async (status) => {
      const cw = fakeConnectWise({ sheets: { 900: sheet(900, { status }) } });
      const result = await call("cw_approve_time_sheet", { id: 900, confirm: true });
      expect(result.isError).toBe(true);
      expect(String(json(result).message)).toContain(`is ${status}, so it is not approved`);
      expect(writes(cw.calls)).toEqual([]);
    },
  );

  it("reports a refusal from ConnectWise with the status and reference", async () => {
    fakeConnectWise({ sheets: { 900: sheet(900) }, failAction: ["approve"] });
    const result = await call("cw_approve_time_sheet", { id: 900, confirm: true });
    expect(result.isError).toBe(true);
    const out = json(result);
    expect(out).toMatchObject({ saved: false, verified: false, statusAfter: "PendingApproval" });
    expect(String(out.error)).toMatch(/POST \/time\/sheets\/900\/approve returned 400 \(reference /);
  });

  it("does not call a sheet approved when ConnectWise answers 200 and the status did not move", async () => {
    fakeConnectWise({ sheets: { 900: sheet(900) }, ignoreAction: ["approve"] });
    const result = await call("cw_approve_time_sheet", { id: 900, confirm: true });
    expect(result.isError).toBe(true);
    const out = json(result);
    expect(out).toMatchObject({ saved: false, verified: false, statusAfter: "PendingApproval" });
    expect(String(out.error)).toMatch(/accepted the approve, but the sheet reads PendingApproval/);
  });
});

describe("cw_submit_time_sheet", () => {
  it("writes nothing without confirm: true and returns the plan", async () => {
    const cw = fakeConnectWise({ sheets: { 900: sheet(900, { status: "Open" }) } });
    const result = await call("cw_submit_time_sheet", { id: 900 });
    expect(result.isError).toBe(true);
    const out = json(result) as { planned: Rec };
    expect(out).toMatchObject({ saved: false, timeSheet: { id: 900, status: "Open" } });
    // A submit has no approval tier, so the plan names none.
    expect(out.planned).toEqual({ call: "POST /time/sheets/900/submit" });
    expect(writes(cw.calls)).toEqual([]);
  });

  it.each(["Open", "Rejected"])("submits a sheet that is %s with an empty body and reads PendingApproval back", async (status) => {
    const cw = fakeConnectWise({ sheets: { 900: sheet(900, { status }) } });
    const result = await call("cw_submit_time_sheet", { id: 900, confirm: true });
    expect(result.isError).not.toBe(true);
    const out = json(result);
    expect(out).toMatchObject({ saved: true, verified: true, action: "submit", statusBefore: status, statusAfter: "PendingApproval" });
    expect(out).not.toHaveProperty("approvalType");
    expect(sent(cw.calls)).toEqual(["POST /time/sheets/900/submit"]);
    expect(writes(cw.calls)[0].body).toEqual({});
  });

  it.each(["PendingApproval", "ApprovedByTierOne", "Billed"])("refuses to submit a sheet that is %s", async (status) => {
    const cw = fakeConnectWise({ sheets: { 900: sheet(900, { status }) } });
    const result = await call("cw_submit_time_sheet", { id: 900, confirm: true });
    expect(result.isError).toBe(true);
    expect(String(json(result).message)).toContain(`is ${status}, so it is not submitted`);
    expect(writes(cw.calls)).toEqual([]);
  });

  it("does not call a sheet submitted when the status did not move", async () => {
    fakeConnectWise({ sheets: { 900: sheet(900, { status: "Open" }) }, ignoreAction: ["submit"] });
    const result = await call("cw_submit_time_sheet", { id: 900, confirm: true });
    expect(result.isError).toBe(true);
    expect(json(result)).toMatchObject({ saved: false, verified: false, statusAfter: "Open" });
  });

  it("takes an approved sheet through reverse, submit and approve, as the live server needs", async () => {
    const cw = fakeConnectWise({ sheets: { 900: sheet(900, { status: "ApprovedByTierOne" }) } });
    expect(json(await call("cw_reverse_time_sheet", { id: 900, reason: "Add a missed entry", confirm: true }))).toMatchObject({ statusAfter: "Open" });
    // Straight after a reverse the sheet is Open, so an approve is refused until it is submitted.
    expect((await call("cw_approve_time_sheet", { id: 900, confirm: true })).isError).toBe(true);
    expect(json(await call("cw_submit_time_sheet", { id: 900, confirm: true }))).toMatchObject({ statusAfter: "PendingApproval" });
    expect(json(await call("cw_approve_time_sheet", { id: 900, confirm: true }))).toMatchObject({ statusAfter: "ApprovedByTierOne" });
    expect(sent(cw.calls)).toEqual(["POST /time/sheets/900/reverse", "POST /time/sheets/900/submit", "POST /time/sheets/900/approve"]);
  });
});

describe("cw_reject_time_sheet and cw_reverse_time_sheet (D20)", () => {
  it("rejects a submitted sheet and returns the reason it was given", async () => {
    const cw = fakeConnectWise({ sheets: { 900: sheet(900) } });
    const result = await call("cw_reject_time_sheet", { id: 900, reason: "Friday has no entries", confirm: true });
    expect(result.isError).not.toBe(true);
    expect(json(result)).toMatchObject({
      verified: true,
      action: "reject",
      statusBefore: "PendingApproval",
      statusAfter: "Rejected",
      reason: "Friday has no entries",
    });
    expect(sent(cw.calls)).toEqual(["POST /time/sheets/900/reject"]);
    // ConnectWise's reject call takes no reason, so none is sent.
    expect(writes(cw.calls)[0].body).toEqual({ approvalType: "Tier1Update" });
  });

  it("names the refusal ConnectWise gives when no time entry on the sheet is rejected, as seen live", async () => {
    // Live on 13/10/2026: 400 with this message, on a submitted sheet whose entries were all unrejected.
    const refusal = {
      code: "InvalidObject",
      message: "timeSheet object is invalid",
      errors: [
        {
          code: "InvalidObject",
          message: "Period 42 / Stephan Jenner cannot be rejected: You must reject the incorrect time entries before rejecting the time sheet.",
          resource: "timeSheet",
          field: "id",
        },
      ],
    };
    expect(refusal).toEqual(LIVE_REJECT_REFUSAL);
    const cw = fakeConnectWise({
      sheets: { 900: sheet(900) },
      entries: { 1: entry(1, { status: "PendingApproval" }) },
      liveReject: true,
    });

    const result = await call("cw_reject_time_sheet", { id: 900, reason: "Friday has no entries", confirm: true });

    expect(result.isError).toBe(true);
    const out = json(result);
    expect(out).toMatchObject({ saved: false, verified: false, refusal: "entries-not-rejected", statusAfter: "PendingApproval" });
    expect(String(out.message)).toMatch(/Pass the incorrect entries in rejectEntryIds, or reject them first with cw_reject_time_entry/);
    expect(cw.state.entries![1].status).toBe("PendingApproval");
  });

  it("rejects the named entries first, with the reason as their comment, then the sheet", async () => {
    const cw = fakeConnectWise({
      sheets: { 900: sheet(900) },
      entries: {
        1: entry(1, { status: "PendingApproval" }),
        2: entry(2, { status: "PendingApproval" }),
        3: entry(3, { status: "PendingApproval", chargeToType: "ProjectTicket" }),
      },
      liveReject: true,
    });

    const result = await call("cw_reject_time_sheet", { id: 900, reason: "Wrong ticket", rejectEntryIds: [1], confirm: true });

    expect(result.isError).not.toBe(true);
    expect(json(result)).toMatchObject({
      saved: true,
      verified: true,
      statusBefore: "PendingApproval",
      statusAfter: "Rejected",
      entries: [{ timeEntryId: 1, ok: true, statusBefore: "PendingApproval", statusAfter: "Rejected" }],
      // Seen live: the entries that were not rejected are passed.
      entryStatuses: { Rejected: 1, ReadyToBill: 1, PendingProjectApproval: 1 },
    });
    expect(sent(cw.calls)).toEqual(["POST /time/entries/1/reject", "POST /time/sheets/900/reject"]);
    expect(writes(cw.calls)[0].body).toEqual({ approvalType: "Tier1Update", comment: "Wrong ticket" });
    expect(writes(cw.calls)[1].body).toEqual({ approvalType: "Tier1Update" });
  });

  it("warns in the reject plan that the other entries will be passed, and lists the entry rejects", async () => {
    const cw = fakeConnectWise({ sheets: { 900: sheet(900) }, entries: { 1: entry(1, { status: "PendingApproval" }) } });
    const out = json(await call("cw_reject_time_sheet", { id: 900, reason: "Wrong ticket", rejectEntryIds: [1] })) as { planned: Rec };
    expect(String((out as Rec).message)).toMatch(/Every time entry on it that is not rejected will be passed/);
    expect(out.planned).toEqual({
      first: ["POST /time/entries/1/reject"],
      call: "POST /time/sheets/900/reject",
      approvalType: "Tier1Update",
    });
    expect(writes(cw.calls)).toEqual([]);
  });

  it("rejects no entry and no sheet when an entry is on another sheet", async () => {
    const cw = fakeConnectWise({
      sheets: { 900: sheet(900) },
      entries: { 1: entry(1, { status: "PendingApproval", timeSheet: { id: 901 } }) },
    });
    const result = await call("cw_reject_time_sheet", { id: 900, reason: "Wrong ticket", rejectEntryIds: [1], confirm: true });
    expect(result.isError).toBe(true);
    expect(String(json(result).message)).toMatch(/Time entry 1 is not on time sheet 900/);
    expect(writes(cw.calls)).toEqual([]);
  });

  it("needs a reason when entries are to be rejected, before any write", async () => {
    const cw = fakeConnectWise({ sheets: { 900: sheet(900) }, entries: { 1: entry(1, { status: "PendingApproval" }) } });
    const result = await call("cw_reject_time_sheet", { id: 900, rejectEntryIds: [1], confirm: true });
    expect(result.isError).toBe(true);
    expect(String(json(result).message)).toMatch(/needs a reason/);
    expect(writes(cw.calls)).toEqual([]);
  });

  it("does not reject the sheet when an entry reject fails", async () => {
    const cw = fakeConnectWise({
      sheets: { 900: sheet(900) },
      entries: { 1: entry(1, { status: "PendingApproval" }) },
      failAction: ["entryReject"],
    });
    const result = await call("cw_reject_time_sheet", { id: 900, reason: "Wrong ticket", rejectEntryIds: [1], confirm: true });
    expect(result.isError).toBe(true);
    expect(json(result)).toMatchObject({ saved: false, verified: false, entries: [{ timeEntryId: 1, ok: false }] });
    expect(sent(cw.calls)).toEqual(["POST /time/entries/1/reject"]);
    expect(cw.state.sheets[900].status).toBe("PendingApproval");
  });

  it("gives no entries-not-rejected reason for another refusal, or on another action", async () => {
    fakeConnectWise({ sheets: { 900: sheet(900) }, failAction: ["reject", "approve"] });
    expect(json(await call("cw_reject_time_sheet", { id: 900, confirm: true }))).not.toHaveProperty("refusal");
    expect(json(await call("cw_approve_time_sheet", { id: 900, confirm: true }))).not.toHaveProperty("refusal");
  });

  it("writes nothing on a reject or a reverse without confirm: true", async () => {
    const cw = fakeConnectWise({ sheets: { 900: sheet(900), 901: sheet(901, { status: "ApprovedByTierOne" }) } });
    expect(json(await call("cw_reject_time_sheet", { id: 900 }))).toMatchObject({ saved: false });
    expect(json(await call("cw_reverse_time_sheet", { id: 901, reason: "Wrong work type on one entry" }))).toMatchObject({
      saved: false,
      planned: { call: "POST /time/sheets/901/reverse" },
      reason: "Wrong work type on one entry",
    });
    expect(writes(cw.calls)).toEqual([]);
  });

  it("refuses to reject a sheet that is approved: it has to be reversed first", async () => {
    const cw = fakeConnectWise({ sheets: { 900: sheet(900, { status: "ApprovedByTierOne" }) } });
    const result = await call("cw_reject_time_sheet", { id: 900, confirm: true });
    expect(result.isError).toBe(true);
    expect(writes(cw.calls)).toEqual([]);
  });

  it("reverses an approved sheet, which leaves it Open", async () => {
    const cw = fakeConnectWise({ sheets: { 900: sheet(900, { status: "ApprovedByTierOne" }) } });
    const result = await call("cw_reverse_time_sheet", { id: 900, reason: "Wrong work type on one entry", confirm: true });
    expect(result.isError).not.toBe(true);
    expect(json(result)).toMatchObject({
      verified: true,
      action: "reverse",
      statusBefore: "ApprovedByTierOne",
      statusAfter: "Open",
      reason: "Wrong work type on one entry",
    });
    expect(sent(cw.calls)).toEqual(["POST /time/sheets/900/reverse"]);
  });

  it("needs a reason for a reverse, before any request", async () => {
    const cw = fakeConnectWise({ sheets: { 900: sheet(900, { status: "ApprovedByTierOne" }) } });
    expect((await call("cw_reverse_time_sheet", { id: 900, confirm: true })).isError).toBe(true);
    expect((await call("cw_reverse_time_sheet", { id: 900, reason: " ", confirm: true })).isError).toBe(true);
    expect(cw.fetchMock).not.toHaveBeenCalled();
  });

  it.each(["Open", "PendingApproval", "Rejected", "ApprovedByTierTwo", "Billed"])(
    "refuses to reverse a sheet that is %s",
    async (status) => {
      const cw = fakeConnectWise({ sheets: { 900: sheet(900, { status }) } });
      const result = await call("cw_reverse_time_sheet", { id: 900, reason: "Test of the guard", confirm: true });
      expect(result.isError).toBe(true);
      expect(writes(cw.calls)).toEqual([]);
    },
  );

  it("does not call a sheet reversed when the status still reads ApprovedByTierOne", async () => {
    fakeConnectWise({ sheets: { 900: sheet(900, { status: "ApprovedByTierOne" }) }, ignoreAction: ["reverse"] });
    const result = await call("cw_reverse_time_sheet", { id: 900, reason: "Test of the read back", confirm: true });
    expect(result.isError).toBe(true);
    expect(json(result)).toMatchObject({ verified: false, statusAfter: "ApprovedByTierOne" });
  });
});

describe("cw_reject_time_entry", () => {
  const submitted = (over: Partial<FakeState> = {}): FakeState => ({
    sheets: { 900: sheet(900) },
    entries: { 1: entry(1, { status: "PendingApproval" }) },
    ...over,
  });

  it("writes nothing without confirm: true and plans the comment", async () => {
    const cw = fakeConnectWise(submitted());
    const result = await call("cw_reject_time_entry", { id: 1, reason: "Wrong ticket" });
    expect(result.isError).toBe(true);
    expect(json(result)).toMatchObject({
      saved: false,
      planned: { call: "POST /time/entries/1/reject", approvalType: "Tier1Update", comment: "Wrong ticket" },
      timeEntryId: 1,
      status: "PendingApproval",
      timeSheet: { id: 900, status: "PendingApproval" },
    });
    expect(writes(cw.calls)).toEqual([]);
  });

  it("rejects the entry with the reason as its comment and reads Rejected back", async () => {
    const cw = fakeConnectWise(submitted());
    const result = await call("cw_reject_time_entry", { id: 1, reason: "Wrong ticket", confirm: true });
    expect(result.isError).not.toBe(true);
    expect(json(result)).toMatchObject({
      saved: true,
      verified: true,
      timeEntryId: 1,
      statusBefore: "PendingApproval",
      statusAfter: "Rejected",
      reason: "Wrong ticket",
    });
    expect(sent(cw.calls)).toEqual(["POST /time/entries/1/reject"]);
    // The body the live server asked for: its 400 named comment as required.
    expect(writes(cw.calls)[0].body).toEqual({ approvalType: "Tier1Update", comment: "Wrong ticket" });
  });

  it("needs a reason before any request", async () => {
    const cw = fakeConnectWise(submitted());
    expect((await call("cw_reject_time_entry", { id: 1, confirm: true })).isError).toBe(true);
    expect((await call("cw_reject_time_entry", { id: 1, reason: "  ", confirm: true })).isError).toBe(true);
    expect(cw.fetchMock).not.toHaveBeenCalled();
  });

  it.each(["Open", "Rejected", "ApprovedByTierOne"])("refuses an entry whose sheet is %s", async (status) => {
    const cw = fakeConnectWise(submitted({ sheets: { 900: sheet(900, { status }) } }));
    const result = await call("cw_reject_time_entry", { id: 1, reason: "Wrong ticket", confirm: true });
    expect(result.isError).toBe(true);
    expect(String(json(result).message)).toContain(`on a time sheet that is ${status}`);
    expect(writes(cw.calls)).toEqual([]);
  });

  it("does not call an entry rejected when its status did not move", async () => {
    fakeConnectWise(submitted({ ignoreAction: ["entryReject"] }));
    const result = await call("cw_reject_time_entry", { id: 1, reason: "Wrong ticket", confirm: true });
    expect(result.isError).toBe(true);
    expect(json(result)).toMatchObject({ saved: false, verified: false, statusAfter: "PendingApproval" });
  });
});

describe("cw_delete_time_entry", () => {
  /** A fake that holds one entry and lets it be deleted. */
  function oneEntry(over: { failDelete?: boolean; keep?: boolean } = {}) {
    let record: Rec | null = entry(1, { status: "Open" });
    const methods: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init: RequestInit = {}) => {
        const method = String(init.method ?? "GET");
        methods.push(method);
        if (method === "DELETE") {
          if (over.failDelete) return jsonResponse({ code: "InvalidObject", message: "Entry is billed" }, 400);
          if (!over.keep) record = null;
          return new Response(null, { status: 204 });
        }
        return record ? jsonResponse(record) : jsonResponse({ code: "NotFound", message: "Not found" }, 404);
      }),
    );
    return { methods, exists: () => record !== null };
  }

  it("is a destructive write that takes confirm", async () => {
    const tools = (await mcp<{ tools: ListedTool[] }>("tools/list", {})).result.tools;
    const tool = tools.find((entry) => entry.name === "cw_delete_time_entry")!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(["confirm", "id"]);
  });

  it("deletes nothing without confirm: true and returns the entry that would go", async () => {
    const cw = oneEntry();
    const result = await call("cw_delete_time_entry", { id: 1 });
    expect(result.isError).toBe(true);
    expect(json(result)).toMatchObject({
      deleted: false,
      entry: {
        id: 1,
        member: { id: 147, name: "Stephan Jenner" },
        company: { id: 250, name: "Future Logic" },
        chargeToId: 904995,
        actualHours: 0.75,
        billableOption: "Billable",
        status: "Open",
        timeSheet: { id: 900 },
      },
    });
    expect(cw.methods).toEqual(["GET"]);
    expect(cw.exists()).toBe(true);
  });

  it("deletes with confirm: true and reads back that the entry is gone", async () => {
    const cw = oneEntry();
    const result = await call("cw_delete_time_entry", { id: 1, confirm: true });
    expect(result.isError).not.toBe(true);
    expect(json(result)).toMatchObject({ id: 1, deleted: true, verified: true, entry: { id: 1 } });
    expect(cw.methods).toEqual(["GET", "DELETE", "GET"]);
    expect(cw.exists()).toBe(false);
  });

  it("does not call an entry deleted when it is still there on the read back", async () => {
    oneEntry({ keep: true });
    const result = await call("cw_delete_time_entry", { id: 1, confirm: true });
    expect(result.isError).toBe(true);
    expect(json(result)).toMatchObject({ deleted: true, verified: false });
  });

  it("reports a refusal from ConnectWise and leaves the entry", async () => {
    const cw = oneEntry({ failDelete: true });
    const result = await call("cw_delete_time_entry", { id: 1, confirm: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/DELETE \/time\/entries\/1 returned 400/);
    expect(cw.exists()).toBe(true);
  });
});

describe("cw_edit_approved_time_entry (D20 guided flow)", () => {
  const args = {
    timeEntryId: 1,
    operations: [{ op: "replace", path: "billableOption", value: "NoCharge" }],
    reason: "Internal work billed by mistake",
  };
  const approved = (over: Partial<FakeState> = {}): FakeState => ({
    sheets: { 900: sheet(900, { status: "ApprovedByTierOne" }) },
    entries: { 1: entry(1) },
    ...over,
  });

  it("writes nothing without confirm: true and returns the plan with the current values", async () => {
    const cw = fakeConnectWise(approved());
    const result = await call("cw_edit_approved_time_entry", args);
    expect(result.isError).toBe(true);
    expect(json(result)).toMatchObject({
      saved: false,
      timeEntryId: 1,
      reason: "Internal work billed by mistake",
      planned: {
        steps: ["POST /time/sheets/900/reverse", "PATCH /time/entries/1", "POST /time/sheets/900/submit", "POST /time/sheets/900/approve"],
        operations: args.operations,
      },
      current: { billableOption: { value: "Billable", shown: "Billable" } },
      timeSheet: { id: 900, status: "ApprovedByTierOne" },
    });
    expect(writes(cw.calls)).toEqual([]);
  });

  it("reverses, edits, submits and approves again, and returns before and after for each changed field", async () => {
    const cw = fakeConnectWise(approved());
    const result = await call("cw_edit_approved_time_entry", { ...args, confirm: true });
    expect(result.isError).not.toBe(true);
    expect(json(result)).toMatchObject({
      completed: true,
      verified: true,
      timeEntryId: 1,
      reason: "Internal work billed by mistake",
      steps: [
        { step: "reverse", ok: true, statusBefore: "ApprovedByTierOne", statusAfter: "Open" },
        { step: "edit", ok: true },
        { step: "submit", ok: true, statusBefore: "Open", statusAfter: "PendingApproval" },
        { step: "approve", ok: true, statusBefore: "PendingApproval", statusAfter: "ApprovedByTierOne" },
      ],
      changes: [{ field: "billableOption", from: "Billable", to: "NoCharge", before: "Billable", after: "NoCharge", inPlan: true }],
      unplannedChanges: [],
      plannedNotChanged: [],
      timeSheet: { id: 900, statusBefore: "ApprovedByTierOne", statusAfter: "ApprovedByTierOne", changes: [] },
    });
    expect(sent(cw.calls)).toEqual([
      "POST /time/sheets/900/reverse",
      "PATCH /time/entries/1",
      "POST /time/sheets/900/submit",
      "POST /time/sheets/900/approve",
    ]);
    expect(writes(cw.calls)[1].body).toEqual(args.operations);
    // A submit takes no body. Reverse and approve take the tier one approval type.
    expect(writes(cw.calls).map((entry) => entry.body)).toEqual([
      { approvalType: "Tier1Update" },
      args.operations,
      {},
      { approvalType: "Tier1Update" },
    ]);
  });

  it("reports a field ConnectWise changed by itself as an unplanned change", async () => {
    // A billing option change moves the rate, and approving again moves the sheet hours.
    fakeConnectWise(
      approved({
        sideEffects: { hourlyRate: 0, workType: { id: 32, name: "NB Business Management", _info: { workType_href: "c" } } },
        sheetSideEffects: { hours: 30.75 },
      }),
    );
    const out = json(await call("cw_edit_approved_time_entry", { ...args, confirm: true })) as {
      changes: Rec[];
      timeSheet: { changes: Rec[] };
    };
    expect(out).toMatchObject({ completed: true, verified: true, unplannedChanges: ["hourlyRate", "workType"] });
    expect(out.changes).toEqual([
      { field: "billableOption", from: "Billable", to: "NoCharge", before: "Billable", after: "NoCharge", inPlan: true },
      { field: "hourlyRate", from: "180", to: "0", before: 180, after: 0, inPlan: false },
      {
        field: "workType",
        from: "> Business Days (830-530)",
        to: "NB Business Management",
        before: { id: 28, name: "> Business Days (830-530)" },
        after: { id: 32, name: "NB Business Management" },
        inPlan: false,
      },
    ]);
    expect(out.timeSheet.changes).toEqual([{ field: "hours", from: "31.5", to: "30.75", before: 31.5, after: 30.75 }]);
  });

  it("names a planned field whose value did not change", async () => {
    fakeConnectWise(approved());
    const out = json(
      await call("cw_edit_approved_time_entry", {
        ...args,
        operations: [{ op: "replace", path: "billableOption", value: "Billable" }],
        confirm: true,
      }),
    );
    expect(out).toMatchObject({ completed: true, changes: [], plannedNotChanged: ["billableOption"] });
  });

  it("takes a nested path as its top-level field", async () => {
    fakeConnectWise(approved());
    const result = await call("cw_edit_approved_time_entry", {
      ...args,
      operations: [{ op: "replace", path: "workType/id", value: 32 }],
    });
    expect(json(result)).toMatchObject({ current: { workType: { value: { id: 28, name: "> Business Days (830-530)" }, shown: "> Business Days (830-530)" } } });
  });

  it("submits and approves the sheet again when ConnectWise refuses the patch, and says the entry was not changed", async () => {
    const cw = fakeConnectWise(approved({ failPatch: true }));
    const result = await call("cw_edit_approved_time_entry", { ...args, confirm: true });
    expect(result.isError).toBe(true);
    const out = json(result) as { steps: Rec[]; message: string };
    expect(out).toMatchObject({ completed: false, verified: false, changes: [], timeSheet: { statusAfter: "ApprovedByTierOne" } });
    expect(out.steps[1]).toMatchObject({ step: "edit", ok: false });
    expect(String(out.steps[1].error)).toMatch(/PATCH \/time\/entries\/1 returned 400/);
    expect(out.steps[2]).toMatchObject({ step: "submit", ok: true });
    expect(out.steps[3]).toMatchObject({ step: "approve", ok: true });
    expect(out.message).toMatch(/not changed.*submitted and approved again, so it is as it was found/);
    expect(sent(cw.calls)).toEqual([
      "POST /time/sheets/900/reverse",
      "PATCH /time/entries/1",
      "POST /time/sheets/900/submit",
      "POST /time/sheets/900/approve",
    ]);
    expect(cw.state.entries![1].billableOption).toBe("Billable");
  });

  it("changes nothing when the reverse does not go through", async () => {
    const cw = fakeConnectWise(approved({ failAction: ["reverse"] }));
    const result = await call("cw_edit_approved_time_entry", { ...args, confirm: true });
    expect(result.isError).toBe(true);
    expect(json(result)).toMatchObject({ completed: false, changes: [], timeSheet: { statusAfter: "ApprovedByTierOne" } });
    expect(sent(cw.calls)).toEqual(["POST /time/sheets/900/reverse"]);
  });

  it("says plainly when the entry changed but the sheet could not be approved again", async () => {
    fakeConnectWise(approved({ failAction: ["approve"] }));
    const result = await call("cw_edit_approved_time_entry", { ...args, confirm: true });
    expect(result.isError).toBe(true);
    const out = json(result) as { message: string };
    expect(out).toMatchObject({
      completed: false,
      verified: false,
      changes: [{ field: "billableOption", to: "NoCharge" }],
      timeSheet: { statusBefore: "ApprovedByTierOne", statusAfter: "PendingApproval" },
    });
    expect(out.message).toMatch(/could NOT be approved again\. It is left submitted and not approved/);
  });

  it("says the sheet is left reversed when the submit does not go through, and does not try to approve", async () => {
    const cw = fakeConnectWise(approved({ failAction: ["submit"] }));
    const result = await call("cw_edit_approved_time_entry", { ...args, confirm: true });
    expect(result.isError).toBe(true);
    const out = json(result) as { message: string; steps: Rec[] };
    expect(out).toMatchObject({
      completed: false,
      verified: false,
      changes: [{ field: "billableOption", to: "NoCharge" }],
      timeSheet: { statusBefore: "ApprovedByTierOne", statusAfter: "Open" },
    });
    expect(out.steps.map((step) => step.step)).toEqual(["reverse", "edit", "submit"]);
    expect(out.message).toMatch(/left reversed and not submitted/);
    expect(sent(cw.calls)).toEqual(["POST /time/sheets/900/reverse", "PATCH /time/entries/1", "POST /time/sheets/900/submit"]);
  });

  it("refuses an entry whose sheet is not approved, and points to the plain update tool", async () => {
    const cw = fakeConnectWise({ sheets: { 900: sheet(900) }, entries: { 1: entry(1) } });
    const result = await call("cw_edit_approved_time_entry", { ...args, confirm: true });
    expect(result.isError).toBe(true);
    expect(String(json(result).message)).toMatch(/is PendingApproval, not ApprovedByTierOne.*cw_update_time_entry/);
    expect(writes(cw.calls)).toEqual([]);
  });

  it("refuses a patch on id, member or timeSheet, or one with no value, before any request", async () => {
    const cw = fakeConnectWise(approved());
    for (const operations of [
      [{ op: "replace", path: "id", value: 2 }],
      [{ op: "replace", path: "member/id", value: 148 }],
      [{ op: "replace", path: "/timeSheet", value: { id: 901 } }],
      [{ op: "replace", path: "notes" }],
    ]) {
      expect((await call("cw_edit_approved_time_entry", { ...args, operations, confirm: true })).isError).toBe(true);
    }
    expect(cw.fetchMock).not.toHaveBeenCalled();
  });

  it("needs a reason before any request", async () => {
    const cw = fakeConnectWise(approved());
    const { reason: _reason, ...noReason } = args;
    expect((await call("cw_edit_approved_time_entry", { ...noReason, confirm: true })).isError).toBe(true);
    expect(cw.fetchMock).not.toHaveBeenCalled();
  });
});

describe("displayValue and diffRecords", () => {
  it("shows values as the Timesheet Review change log shows them", () => {
    expect(displayValue("workType", { id: 28, name: "Business Days" })).toBe("Business Days");
    expect(displayValue("member", { id: 147, identifier: "sjenner" })).toBe("sjenner");
    expect(displayValue("agreement", { id: 114 })).toBe("id 114");
    expect(displayValue("x", { a: 1 })).toBe('{"a":1}');
    expect(displayValue("actualHours", 0.75)).toBe("0.75");
    expect(displayValue("emailCcFlag", false)).toBe("false");
    expect(displayValue("notes", null)).toBe("");
    expect(displayValue("notes", undefined)).toBe("");
    const long = "n".repeat(250);
    expect(displayValue("notes", long)).toBe(`${"n".repeat(200)}...`);
    expect(displayValue("internalNotes", long)).toBe(`${"n".repeat(200)}...`);
    expect(displayValue("summary", long)).toBe(long);
  });

  it("ignores _info, at the top and inside a reference", () => {
    const before = { a: 1, ref: { id: 1, name: "A", _info: { href: "old" } }, _info: { lastUpdated: "x" } };
    const after = { a: 1, ref: { id: 1, name: "A", _info: { href: "new" } }, _info: { lastUpdated: "y" } };
    expect(diffRecords(before, after)).toEqual([]);
  });

  it("lists a field that was added or removed", () => {
    expect(diffRecords({ a: 1 }, { b: "x" })).toEqual([
      { field: "a", from: "1", to: "", before: 1, after: null },
      { field: "b", from: "", to: "x", before: null, after: "x" },
    ]);
  });
});

describe("missing time sheets (D21)", () => {
  const holidays: HolidayData = {
    lists: {
      "Public Holidays 2026 - WA": ["2026-09-28", "2026-12-25", "2026-12-28"],
      "Public Holidays 2026 - PH": ["2026-11-02", "2026-11-30"],
      "Public Holidays 2026 - NSW": ["2026-10-05"],
    },
    members: {
      stuite: "Public Holidays 2026 - WA",
      cpfeil: "Public Holidays 2026 - WA",
      kJandayan: "Public Holidays 2026 - PH",
      aPatingan: "Public Holidays 2026 - PH",
      yeid: "Public Holidays 2026 - NSW",
    },
    waList: "Public Holidays 2026 - WA",
  };
  const member = (identifier: string, firstName: string) => ({ identifier, firstName, officeEmail: `${firstName.toLowerCase()}@example.test` });
  const members = [member("stuite", "Sylvia"), member("cpfeil", "Chris"), member("kJandayan", "Katrina"), member("aPatingan", "Ariz"), member("yeid", "Yahya"), member("nocal", "Nora")];
  const open = (id: number, identifier: string, start: string, end: string, over: Rec = {}) => ({
    id,
    member: { identifier, name: identifier },
    status: "Open",
    hours: 1,
    dateStart: `${start}T00:00:00Z`,
    dateEnd: `${end}T00:00:00Z`,
    ...over,
  });
  const find = (sheets: Rec[], now: string, excludeMembers: string[] = []) =>
    findMissingSheets({ sheets, members, holidays, now: perthClock(now), excludeMembers, dueHourPerth: 10 });
  const flat = (people: ReturnType<typeof find>) =>
    people.flatMap((person) => person.periods.map((period) => `${person.identifier}:${period.sheetId}:${period.businessDaysOverdue}`));

  it("gives the same people, sheets and business days as overdue-check.js for 12/10/2026 17:01", () => {
    // The five sheets and the result are Nathan's saved run, runs/nudges/2026-10-12-1701/candidates.json.
    const sheets = [
      open(13793, "stuite", "2026-09-26", "2026-10-02"),
      open(13807, "stuite", "2026-10-03", "2026-10-09"),
      open(13806, "cpfeil", "2026-10-03", "2026-10-09"),
      open(13809, "kJandayan", "2026-10-03", "2026-10-09"),
      open(13810, "aPatingan", "2026-10-03", "2026-10-09"),
    ];
    expect(flat(find(sheets, "2026-10-12T17:01")).sort()).toEqual(
      ["stuite:13793:5", "stuite:13807:0", "cpfeil:13806:0", "kJandayan:13809:0", "aPatingan:13810:0"].sort(),
    );
    const sylvia = find(sheets, "2026-10-12T17:01").find((person) => person.identifier === "stuite")!;
    expect(sylvia).toMatchObject({ firstName: "Sylvia", email: "sylvia@example.test", holidayList: "Public Holidays 2026 - WA" });
    expect(sylvia.periods[0]).toEqual({
      sheetId: 13793,
      start: "2026-09-26",
      end: "2026-10-02",
      label: "26/09/2026 to 02/10/2026",
      status: "Open",
      hours: 1,
      dueDay: "2026-10-05",
      businessDaysOverdue: 5,
    });
  });

  it("is not missing before 10am Perth on the due Monday, and is from 10am", () => {
    const sheets = [open(1, "cpfeil", "2026-10-03", "2026-10-09")];
    expect(find(sheets, "2026-10-12T09:59")).toEqual([]);
    expect(flat(find(sheets, "2026-10-12T10:00"))).toEqual(["cpfeil:1:0"]);
    expect(flat(find(sheets, "2026-10-13T08:00"))).toEqual(["cpfeil:1:1"]);
  });

  it("does not count the weekend as business days overdue", () => {
    const sheets = [open(1, "cpfeil", "2026-10-03", "2026-10-09")];
    expect(flat(find(sheets, "2026-10-16T12:00"))).toEqual(["cpfeil:1:4"]);
    expect(flat(find(sheets, "2026-10-18T12:00"))).toEqual(["cpfeil:1:4"]);
    expect(flat(find(sheets, "2026-10-19T12:00"))).toEqual(["cpfeil:1:5"]);
  });

  it("moves the due day past a public holiday on the member's own list", () => {
    // Monday 05/10/2026 is a public holiday in NSW, not in WA.
    const sheets = [open(1, "yeid", "2026-09-26", "2026-10-02"), open(2, "cpfeil", "2026-09-26", "2026-10-02")];
    const mondayNoon = find(sheets, "2026-10-05T12:00");
    expect(flat(mondayNoon)).toEqual(["cpfeil:2:0"]);
    const tuesdayNoon = find(sheets, "2026-10-06T12:00");
    expect(flat(tuesdayNoon).sort()).toEqual(["cpfeil:2:1", "yeid:1:0"]);
    expect(tuesdayNoon.find((person) => person.identifier === "yeid")!.periods[0].dueDay).toBe("2026-10-06");
  });

  it("uses the WA list for a member whose calendar names no list", () => {
    // Monday 28/09/2026 is a public holiday in WA.
    const sheets = [open(1, "nocal", "2026-09-19", "2026-09-25")];
    expect(find(sheets, "2026-09-28T12:00")).toEqual([]);
    const tuesday = find(sheets, "2026-09-29T12:00");
    expect(flat(tuesday)).toEqual(["nocal:1:0"]);
    expect(tuesday[0].holidayList).toBe("Public Holidays 2026 - WA");
  });

  it("counts Open and Rejected only", () => {
    const sheets = ["Open", "Rejected", "PendingApproval", "ErrorsCorrected", "ApprovedByTierOne", "Billed"].map((status, index) =>
      open(index + 1, "cpfeil", "2026-10-03", "2026-10-09", { status }),
    );
    expect(flat(find(sheets, "2026-10-12T12:00"))).toEqual(["cpfeil:1:0", "cpfeil:2:0"]);
  });

  it("leaves out a member who is not active, and a member passed in excludeMembers", () => {
    const sheets = [open(1, "cpfeil", "2026-10-03", "2026-10-09"), open(2, "gone", "2026-10-03", "2026-10-09"), open(3, "stuite", "2026-10-03", "2026-10-09")];
    expect(flat(find(sheets, "2026-10-12T12:00")).sort()).toEqual(["cpfeil:1:0", "stuite:3:0"]);
    expect(flat(find(sheets, "2026-10-12T12:00", ["stuite"]))).toEqual(["cpfeil:1:0"]);
    // Nothing is left out unless it is passed in.
    expect(flat(find(sheets, "2026-10-12T12:00", []))).toHaveLength(2);
  });

  it("isBusinessDay reads the weekday and the member's list", () => {
    const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
    expect(isBusinessDay(day("2026-10-12"), "cpfeil", holidays)).toBe(true);
    expect(isBusinessDay(day("2026-10-10"), "cpfeil", holidays)).toBe(false);
    expect(isBusinessDay(day("2026-10-05"), "yeid", holidays)).toBe(false);
    expect(isBusinessDay(day("2026-10-05"), "cpfeil", holidays)).toBe(true);
    expect(isBusinessDay(day("2026-09-28"), undefined, holidays)).toBe(false);
  });

  it("cw_list_missing_time_sheets reads sheets, active members and each holiday list, and writes nothing", async () => {
    const cw = fakeConnectWise({
      sheets: {
        1: open(1, "cpfeil", "2026-10-03", "2026-10-09"),
        2: open(2, "yeid", "2026-09-26", "2026-10-02", { status: "Rejected" }),
        3: open(3, "NColyer-Long", "2026-10-03", "2026-10-09"),
      },
      members: [
        { identifier: "cpfeil", firstName: "Chris", officeEmail: "chris@example.test", calendar: { id: 3 } },
        { identifier: "yeid", firstName: "Yahya", officeEmail: "yahya@example.test", calendar: { id: 4 } },
        { identifier: "NColyer-Long", firstName: "Nathan", officeEmail: "nathan@example.test" },
      ],
      calendars: [
        { id: 3, name: "FL - Perth Tech", holidayList: { id: 18, name: "Public Holidays 2026 - WA" } },
        { id: 4, name: "FL - Sydney Tech", holidayList: { id: 19, name: "Public Holidays 2026 - NSW" } },
        { id: 9, name: "No list" },
      ],
      holidays: { 18: ["2026-09-28"], 19: ["2026-10-05"] },
    });
    const result = await call("cw_list_missing_time_sheets", { now: "2026-10-12T17:01", excludeMembers: ["NColyer-Long"] });
    expect(result.isError).not.toBe(true);
    const out = json(result) as { people: Array<{ identifier: string; periods: Rec[] }> };
    expect(out).toMatchObject({
      asAtPerth: "2026-10-12 17:01",
      dueHourPerth: 10,
      lookbackWeeks: 6,
      excludeMembers: ["NColyer-Long"],
      peopleCount: 2,
      sheetCount: 2,
      holidayLists: { "Public Holidays 2026 - WA": 1, "Public Holidays 2026 - NSW": 1 },
      fallBackHolidayList: "Public Holidays 2026 - WA",
    });
    expect(out.people.map((person) => person.identifier).sort()).toEqual(["cpfeil", "yeid"]);
    // Yahya's sheet was due Tuesday 06/10 (NSW holiday on the Monday): 4 business days to Monday 12/10.
    expect(out.people.find((person) => person.identifier === "yeid")!.periods[0]).toMatchObject({ status: "Rejected", dueDay: "2026-10-06", businessDaysOverdue: 4 });

    const sheetCall = cw.calls.find((entry) => entry.path === "/time/sheets")!;
    expect(sheetCall.query.conditions).toBe("dateStart>=[2026-08-31]");
    expect(cw.calls.find((entry) => entry.path === "/system/members")!.query.conditions).toBe("inactiveFlag=false");
    expect(cw.calls.filter((entry) => /holidayLists/.test(entry.path)).map((entry) => entry.path).sort()).toEqual([
      "/schedule/holidayLists/18/holidays",
      "/schedule/holidayLists/19/holidays",
    ]);
    expect(writes(cw.calls)).toEqual([]);
  });

  it("refuses a now that is not Perth local YYYY-MM-DDTHH:mm, before any request", async () => {
    const cw = fakeConnectWise({ sheets: {} });
    for (const now of ["2026-10-13", "13/10/2026 11:00", "2026-10-13T11:00:00Z"]) {
      expect((await call("cw_list_missing_time_sheets", { now })).isError).toBe(true);
    }
    expect(cw.fetchMock).not.toHaveBeenCalled();
  });
});

describe("time sheet shapes", () => {
  it("toLeanTimeSheet holds stable keys for a sheet with almost nothing set", () => {
    expect(toLeanTimeSheet({ id: 1 })).toEqual({
      id: 1,
      member: null,
      status: null,
      hours: null,
      dateStart: null,
      dateEnd: null,
      label: null,
      year: null,
      period: null,
      deadline: null,
      _info: { lastUpdated: null, updatedBy: null },
    });
  });

  it("perthClock reads a Perth local time through UTC fields", () => {
    const clock = perthClock("2026-10-13T11:00");
    expect([clock.getUTCFullYear(), clock.getUTCMonth() + 1, clock.getUTCDate(), clock.getUTCHours()]).toEqual([2026, 10, 13, 11]);
  });
});

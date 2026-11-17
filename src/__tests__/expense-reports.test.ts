/**
 * Tests for the expense report tools: search, get, submit, approve, reject
 * and reverse (Expense Claim Review, CW 911509).
 *
 * The tools are driven through the Worker's MCP endpoint in gateway mode, so
 * the registration, the input schema and the outbound request are all covered.
 * ConnectWise is a fake that holds reports and entries. It follows what was
 * seen on our instance: approve with Tier1Update reads ApprovedByTierOne, and
 * an entry reject answers 404. The reject and submit behaviour is not yet
 * proven live, so the fake models it as the time sheet routes behave and the
 * tests check what the tool does with each answer.
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

const json = (result: ToolResult): Rec => JSON.parse(result.content[0].text) as Rec;

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
  reports: Record<number, Rec>;
  entries: Record<number, Rec>;
  /** Actions (submit, approve, reject, reverse) that answer 400. */
  failAction?: string[];
  /** Actions that answer 200 and leave the status as it was. */
  ignoreAction?: string[];
  /** Status a reject leaves on the entries. */
  rejectEntryStatus?: string;
}

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

    if (path === "/expense/reports" && method === "GET") return list(Object.values(state.reports));
    if ((match = path.match(/^\/expense\/reports\/(\d+)$/))) {
      const report = state.reports[Number(match[1])];
      if (!report) return notFound();
      if (method === "GET") return jsonResponse(report);
      return jsonResponse({ code: "MethodNotAllowed", message: "Method not allowed" }, 405);
    }
    if ((match = path.match(/^\/expense\/reports\/(\d+)\/(submit|approve|reject|reverse)$/)) && method === "POST") {
      const report = state.reports[Number(match[1])];
      const action = match[2];
      if (!report) return notFound();
      if (state.failAction?.includes(action)) {
        return jsonResponse({ code: "InvalidObject", message: "approvalType is not valid" }, 400);
      }
      if (!state.ignoreAction?.includes(action)) {
        const onReport = Object.values(state.entries).filter((entry) => (entry.expenseReport as Rec).id === report.id);
        if (action === "approve") {
          report.status = "ApprovedByTierOne";
          for (const entry of onReport) entry.status = "ReadyToBill";
        }
        if (action === "reject") {
          report.status = "Rejected";
          for (const entry of onReport) entry.status = state.rejectEntryStatus ?? "Rejected";
        }
        if (action === "reverse") {
          report.status = "Open";
          for (const entry of onReport) entry.status = "Open";
        }
        if (action === "submit") {
          report.status = report.status === "Rejected" ? "ErrorsCorrected" : "PendingApproval";
          for (const entry of onReport) entry.status = report.status;
        }
      }
      return jsonResponse({ success: true });
    }
    if (path === "/expense/entries" && method === "GET") {
      const wanted = /expenseReport\/id=(\d+)/.exec(query.conditions ?? "")?.[1];
      return list(
        Object.values(state.entries).filter((entry) => wanted === undefined || (entry.expenseReport as Rec).id === Number(wanted)),
      );
    }
    if (/^\/expense\/entries\/\d+\/reject$/.test(path)) return notFound();
    return jsonResponse({ code: "NotFound", message: `Unexpected ${method} ${path}` }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock, state };
}

function report(id: number, status: string, extra: Rec = {}): Rec {
  return {
    id,
    name: `Report ${id}`,
    member: { id: 7, identifier: "esmith", name: "Eve Smith" },
    status,
    startDate: "2026-11-01T00:00:00Z",
    endDate: "2026-11-14T00:00:00Z",
    total: 120.5,
    _info: { lastUpdated: "2026-11-15T01:00:00Z", updatedBy: "nathan" },
    ...extra,
  };
}

function entry(id: number, reportId: number, status: string, extra: Rec = {}): Rec {
  return {
    id,
    date: "2026-11-03T00:00:00Z",
    amount: 60.25,
    status,
    type: { id: 3, name: "Fuel" },
    notes: "Ampol, Petrol",
    billableOption: "DoNotBill",
    chargeToType: "ChargeCode",
    chargeToId: 99,
    company: { id: 250, name: "Future Logic" },
    expenseReport: { id: reportId },
    ...extra,
  };
}

function twoEntryState(status: string, extra: Partial<FakeState> = {}): FakeState {
  return {
    reports: { 500: report(500, status) },
    entries: { 1: entry(1, 500, status), 2: entry(2, 500, status) },
    ...extra,
  };
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");
const sent = (calls: Call[]) => writes(calls).map((c) => `${c.method} ${c.path}`);

afterEach(() => vi.unstubAllGlobals());

describe("expense report tools, registration", () => {
  it("registers the reads as read-only and the writes with confirm, and no delete or edit", async () => {
    const tools = (await mcp<{ tools: ListedTool[] }>("tools/list", {})).result.tools;
    const find = (name: string) => tools.find((tool) => tool.name === name)!;
    for (const name of ["cw_search_expense_reports", "cw_get_expense_report"]) {
      expect(find(name), name).toBeDefined();
      expect(find(name).annotations, name).toMatchObject({ readOnlyHint: true });
      expect(find(name).inputSchema.properties, name).not.toHaveProperty("confirm");
    }
    const writeNames = [
      "cw_submit_expense_report",
      "cw_approve_expense_report",
      "cw_reject_expense_report",
      "cw_reverse_expense_report",
    ];
    for (const name of writeNames) {
      expect(find(name), name).toBeDefined();
      expect(find(name).annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(find(name).inputSchema.properties, name).toHaveProperty("confirm");
    }
    expect(find("cw_reject_expense_report").inputSchema.required?.sort()).toEqual(["id", "reason"]);
    expect(find("cw_reverse_expense_report").inputSchema.required?.sort()).toEqual(["id", "reason"]);
    const reportTools = tools.filter((t) => /expense_report/.test(t.name));
    expect(reportTools.map((t) => t.name).sort()).toEqual(
      ["cw_search_expense_reports", "cw_get_expense_report", ...writeNames].sort(),
    );
    for (const tool of reportTools) expect(tool.inputSchema.properties, tool.name).not.toHaveProperty("approvalType");
  });
});

describe("cw_search_expense_reports and cw_get_expense_report", () => {
  it("searches lean for any member and builds the filters", async () => {
    const { calls } = fakeConnectWise({ reports: { 500: report(500, "PendingApproval") }, entries: {} });
    const out = json(
      await call("cw_search_expense_reports", {
        memberIdentifier: "esmith",
        status: "PendingApproval",
        periodStartFrom: "2026-11-01",
        periodStartTo: "2026-11-30",
      }),
    );
    expect(out.count).toBe(1);
    const row = (out.expenseReports as Rec[])[0];
    expect(row).toMatchObject({ id: 500, status: "PendingApproval", startDate: "2026-11-01", endDate: "2026-11-14", total: 120.5 });
    expect(row.member).toEqual({ id: 7, identifier: "esmith", name: "Eve Smith" });
    const conditions = calls[0].query.conditions;
    expect(conditions).toContain("member/identifier='esmith'");
    expect(conditions).toContain("status='PendingApproval'");
    expect(conditions).toContain("startDate>=[2026-11-01]");
    expect(conditions).toContain("startDate<=[2026-11-30]");
    expect(writes(calls)).toEqual([]);
  });

  it("refuses a filter that could break out of the condition, before any request", async () => {
    const { calls } = fakeConnectWise({ reports: {}, entries: {} });
    const result = await call("cw_search_expense_reports", { memberIdentifier: "x' or id>0 or 'a'='a" });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("gets a report with its entries and a count by status", async () => {
    const { calls } = fakeConnectWise(twoEntryState("PendingApproval"));
    const out = json(await call("cw_get_expense_report", { id: 500 }));
    expect(out.entryCount).toBe(2);
    expect(out.entryStatuses).toEqual({ PendingApproval: 2 });
    expect((out.entries as Rec[])[0]).toMatchObject({ id: 1, amount: 60.25, notes: "Ampol, Petrol", date: "2026-11-03" });
    expect(calls.find((c) => c.path === "/expense/entries")!.query.conditions).toBe("expenseReport/id=500");
  });

  it("leaves the entries out when asked", async () => {
    const { calls } = fakeConnectWise(twoEntryState("PendingApproval"));
    const out = json(await call("cw_get_expense_report", { id: 500, includeEntries: false }));
    expect(out).not.toHaveProperty("entries");
    expect(calls.some((c) => c.path === "/expense/entries")).toBe(false);
  });
});

describe("cw_approve_expense_report", () => {
  it("writes nothing without confirm: true and returns the plan with the entries", async () => {
    const { calls } = fakeConnectWise(twoEntryState("PendingApproval"));
    const result = await call("cw_approve_expense_report", { id: 500 });
    const out = json(result);
    expect(result.isError).toBe(true);
    expect(out.saved).toBe(false);
    expect(out.planned).toEqual({ call: "POST /expense/reports/500/approve", approvalType: "Tier1Update" });
    expect((out.entries as Rec[]).length).toBe(2);
    expect(writes(calls)).toEqual([]);
  });

  it("approves at tier one with Tier1Update and reads ApprovedByTierOne back", async () => {
    const { calls } = fakeConnectWise(twoEntryState("PendingApproval"));
    const out = json(await call("cw_approve_expense_report", { id: 500, confirm: true }));
    expect(out).toMatchObject({ saved: true, verified: true, statusBefore: "PendingApproval", statusAfter: "ApprovedByTierOne" });
    expect(out.entryStatuses).toEqual({ ReadyToBill: 2 });
    expect(sent(calls)).toEqual(["POST /expense/reports/500/approve"]);
    expect(writes(calls)[0].body).toEqual({ approvalType: "Tier1Update" });
  });

  it("takes an ErrorsCorrected report", async () => {
    fakeConnectWise(twoEntryState("ErrorsCorrected"));
    const out = json(await call("cw_approve_expense_report", { id: 500, confirm: true }));
    expect(out.verified).toBe(true);
  });

  it("refuses an Open, Rejected or already approved report before any write", async () => {
    for (const status of ["Open", "ApprovedByTierOne", "Rejected"]) {
      const { calls } = fakeConnectWise(twoEntryState(status));
      const result = await call("cw_approve_expense_report", { id: 500, confirm: true });
      expect(result.isError, status).toBe(true);
      expect(json(result).message, status).toContain(`is ${status}`);
      expect(writes(calls), status).toEqual([]);
      vi.unstubAllGlobals();
    }
  });

  it("does not call a report approved when ConnectWise answers 200 and the status did not move", async () => {
    fakeConnectWise(twoEntryState("PendingApproval", { ignoreAction: ["approve"] }));
    const result = await call("cw_approve_expense_report", { id: 500, confirm: true });
    const out = json(result);
    expect(result.isError).toBe(true);
    expect(out.verified).toBe(false);
    expect(out.saved).toBe(false);
    expect(out.error).toContain("reads PendingApproval");
  });

  it("reports a refusal from ConnectWise with the status and a reference", async () => {
    fakeConnectWise(twoEntryState("PendingApproval", { failAction: ["approve"] }));
    const result = await call("cw_approve_expense_report", { id: 500, confirm: true });
    const out = json(result);
    expect(result.isError).toBe(true);
    expect(out.verified).toBe(false);
    expect(String(out.error)).toMatch(/returned 400/);
  });
});

describe("cw_reject_expense_report", () => {
  it("needs a reason, before any request", async () => {
    const { calls } = fakeConnectWise(twoEntryState("PendingApproval"));
    const result = await call("cw_reject_expense_report", { id: 500, confirm: true });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("writes nothing without confirm: true and plans the comment and the entries", async () => {
    const { calls } = fakeConnectWise(twoEntryState("PendingApproval"));
    const result = await call("cw_reject_expense_report", { id: 500, reason: "Receipt missing on the fuel claim" });
    const out = json(result);
    expect(result.isError).toBe(true);
    expect(out.saved).toBe(false);
    expect(out.planned).toEqual({
      call: "POST /expense/reports/500/reject",
      approvalType: "Tier1Update",
      comment: "Receipt missing on the fuel claim",
    });
    expect(out.entryStatuses).toEqual({ PendingApproval: 2 });
    expect(writes(calls)).toEqual([]);
  });

  it("rejects with the reason as the comment and reads the report and every entry back", async () => {
    const { calls } = fakeConnectWise(twoEntryState("PendingApproval"));
    const out = json(
      await call("cw_reject_expense_report", { id: 500, reason: "Receipt missing on the fuel claim", confirm: true }),
    );
    expect(out).toMatchObject({ saved: true, verified: true, statusBefore: "PendingApproval", statusAfter: "Rejected" });
    expect(out.entryStatusesBefore).toEqual({ PendingApproval: 2 });
    expect(out.entryStatuses).toEqual({ Rejected: 2 });
    expect((out.entries as Rec[]).map((e) => e.status)).toEqual(["Rejected", "Rejected"]);
    expect(sent(calls)).toEqual(["POST /expense/reports/500/reject"]);
    expect(writes(calls)[0].body).toEqual({ approvalType: "Tier1Update", comment: "Receipt missing on the fuel claim" });
    const post = calls.findIndex((c) => c.method === "POST");
    expect(calls.slice(post + 1).some((c) => c.path === "/expense/reports/500")).toBe(true);
  });

  it("shows the entry counts when a reject moves entries to another status", async () => {
    fakeConnectWise(twoEntryState("PendingApproval", { rejectEntryStatus: "ReadyToBill" }));
    const out = json(await call("cw_reject_expense_report", { id: 500, reason: "Wrong expense type", confirm: true }));
    expect(out.statusAfter).toBe("Rejected");
    expect(out.entryStatuses).toEqual({ ReadyToBill: 2 });
  });

  it("returns ConnectWise's refusal of the comment and leaves the report alone", async () => {
    const { state } = fakeConnectWise(twoEntryState("PendingApproval", { failAction: ["reject"] }));
    const result = await call("cw_reject_expense_report", { id: 500, reason: "Wrong expense type", confirm: true });
    const out = json(result);
    expect(result.isError).toBe(true);
    expect(out.verified).toBe(false);
    expect(out.statusAfter).toBe("PendingApproval");
    expect(state.reports[500].status).toBe("PendingApproval");
  });

  it("does not call a report rejected when the status did not move", async () => {
    fakeConnectWise(twoEntryState("PendingApproval", { ignoreAction: ["reject"] }));
    const result = await call("cw_reject_expense_report", { id: 500, reason: "Wrong expense type", confirm: true });
    expect(result.isError).toBe(true);
    expect(json(result).verified).toBe(false);
  });

  it("refuses an Open or approved report, so a reject cannot move it by accident", async () => {
    for (const status of ["Open", "ApprovedByTierOne"]) {
      const { calls } = fakeConnectWise(twoEntryState(status));
      const result = await call("cw_reject_expense_report", { id: 500, reason: "Wrong expense type", confirm: true });
      expect(result.isError, status).toBe(true);
      expect(writes(calls), status).toEqual([]);
      vi.unstubAllGlobals();
    }
  });

  it("has no entry reject: no call to /expense/entries/{id}/reject is ever made", async () => {
    const { calls } = fakeConnectWise(twoEntryState("PendingApproval"));
    await call("cw_reject_expense_report", { id: 500, reason: "Wrong expense type", confirm: true });
    expect(calls.some((c) => /\/expense\/entries\/\d+\/reject/.test(c.path))).toBe(false);
  });
});

describe("cw_submit_expense_report", () => {
  it("writes nothing without confirm: true", async () => {
    const { calls } = fakeConnectWise(twoEntryState("Rejected"));
    const result = await call("cw_submit_expense_report", { id: 500 });
    expect(result.isError).toBe(true);
    expect(json(result).planned).toEqual({ call: "POST /expense/reports/500/submit" });
    expect(writes(calls)).toEqual([]);
  });

  it("submits a Rejected report with an empty body and takes ErrorsCorrected as good", async () => {
    const { calls } = fakeConnectWise(twoEntryState("Rejected"));
    const out = json(await call("cw_submit_expense_report", { id: 500, confirm: true }));
    expect(out).toMatchObject({ verified: true, statusBefore: "Rejected", statusAfter: "ErrorsCorrected" });
    expect(writes(calls)[0].body).toEqual({});
  });

  it("submits an Open report to PendingApproval", async () => {
    fakeConnectWise(twoEntryState("Open"));
    const out = json(await call("cw_submit_expense_report", { id: 500, confirm: true }));
    expect(out).toMatchObject({ verified: true, statusAfter: "PendingApproval" });
  });

  it("refuses a report that is already submitted or approved", async () => {
    for (const status of ["PendingApproval", "ApprovedByTierOne"]) {
      const { calls } = fakeConnectWise(twoEntryState(status));
      const result = await call("cw_submit_expense_report", { id: 500, confirm: true });
      expect(result.isError, status).toBe(true);
      expect(writes(calls), status).toEqual([]);
      vi.unstubAllGlobals();
    }
  });
});

describe("cw_reverse_expense_report", () => {
  it("refuses every status except ApprovedByTierOne before calling ConnectWise", async () => {
    for (const status of ["Open", "PendingApproval", "ErrorsCorrected", "Rejected", "ReadyToBill", "Billed"]) {
      const { calls } = fakeConnectWise(twoEntryState(status));
      const result = await call("cw_reverse_expense_report", { id: 500, reason: "Wrong entry type", confirm: true });
      expect(result.isError, status).toBe(true);
      expect(json(result).message, status).toContain("Nothing was changed");
      expect(writes(calls), status).toEqual([]);
      vi.unstubAllGlobals();
    }
  });

  it("needs a reason, before any request", async () => {
    const { calls } = fakeConnectWise(twoEntryState("ApprovedByTierOne"));
    const result = await call("cw_reverse_expense_report", { id: 500, confirm: true });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("writes nothing without confirm: true", async () => {
    const { calls } = fakeConnectWise(twoEntryState("ApprovedByTierOne"));
    const result = await call("cw_reverse_expense_report", { id: 500, reason: "Wrong entry type" });
    expect(result.isError).toBe(true);
    expect(json(result).saved).toBe(false);
    expect(writes(calls)).toEqual([]);
  });

  it("reverses an approved report with Tier1Update and reads Open back", async () => {
    const { calls } = fakeConnectWise(twoEntryState("ApprovedByTierOne"));
    const out = json(await call("cw_reverse_expense_report", { id: 500, reason: "Wrong entry type", confirm: true }));
    expect(out).toMatchObject({ verified: true, statusBefore: "ApprovedByTierOne", statusAfter: "Open", reason: "Wrong entry type" });
    expect(writes(calls)[0].body).toEqual({ approvalType: "Tier1Update" });
  });

  it("does not call a report reversed when it still reads ApprovedByTierOne", async () => {
    fakeConnectWise(twoEntryState("ApprovedByTierOne", { ignoreAction: ["reverse"] }));
    const result = await call("cw_reverse_expense_report", { id: 500, reason: "Wrong entry type", confirm: true });
    expect(result.isError).toBe(true);
    expect(json(result).verified).toBe(false);
  });
});

describe("expense report tools, limits", () => {
  it("never sends PATCH, PUT or DELETE on a report or an entry", async () => {
    const { calls } = fakeConnectWise(twoEntryState("PendingApproval"));
    await call("cw_approve_expense_report", { id: 500, confirm: true });
    expect(calls.filter((c) => ["PATCH", "PUT", "DELETE"].includes(c.method))).toEqual([]);
  });
});

/**
 * Tests for WS3 Group 3, projects, time and companies: cw_create_project with
 * required billing, cw_create_project_ticket, the billableOption and timeSheet
 * parameters on cw_create_time_entry, and company types through
 * typeAssociations.
 *
 * The tools are driven through the Worker's MCP endpoint in gateway mode. A
 * small in-test fake stands in for the ConnectWise endpoints the tools call.
 * Test infrastructure only: nothing here is a live ConnectWise result, and no
 * test makes a network call.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../worker.js";
import { companyPatchTouchesTypes } from "../tools/company-types.js";

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

function body(result: ToolResult): Rec {
  return JSON.parse(result.content[0].text) as Rec;
}

/** ConnectWise's own words for a time period that is not open, as the WS3 live proof saw them. */
const LIVE_PERIOD_REFUSAL =
  "Time period specified is invalid or not open, provide a new date for this time entry.";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

interface World {
  projects: Record<number, Rec>;
  phases: Record<number, Rec[]> | null;
  projectTickets: Record<number, Rec>;
  serviceTickets: Record<number, Rec>;
  timeEntries: Record<number, Rec>;
  companyTypes: Rec[];
  associations: Record<number, Rec[]>;
  /** Make the project accept the create but drop the agreement. */
  dropAgreement: boolean;
  /** Make the project ticket accept the create but drop the phase. */
  dropPhase: boolean;
  /** Make the time entry accept the create but drop billableOption. */
  dropBillable: boolean;
  /**
   * The member's time sheet for the period is submitted or approved. As seen live on
   * 13/10/2026: an entry with no timeSheet is refused as "time period not open", and an
   * entry with a timeSheet is answered with a bare 500.
   */
  periodClosed: boolean;
  /** The 400 body for that refusal. Default: ConnectWise's own wording, as seen live. */
  refusalBody: Rec | null;
  /** Status the nested typeAssociations POST answers, when not 2xx. */
  nestedPostStatus: number | null;
}

function fakeConnectWise(initial: Partial<World> = {}) {
  const world: World = {
    projects: {},
    phases: {},
    projectTickets: {},
    serviceTickets: {},
    timeEntries: {},
    companyTypes: [],
    associations: {},
    dropAgreement: false,
    dropPhase: false,
    dropBillable: false,
    periodClosed: false,
    refusalBody: null,
    nestedPostStatus: null,
    ...initial,
  };
  const calls: Call[] = [];
  let nextAssociation = 5000;
  const notFound = () => jsonResponse({ code: "NotFound", message: "Not found" }, 404);

  const fetchMock = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const path = new URL(String(url)).pathname.replace("/v4_6_release/apis/3.0", "");
    const method = String(init.method ?? "GET");
    const payload = init.body ? (JSON.parse(String(init.body)) as Rec) : undefined;
    calls.push({ method, path, body: payload });
    let m: RegExpMatchArray | null;

    if (path === "/project/projects" && method === "POST") {
      const record: Rec = { id: 600, status: { id: 1, name: "New" }, ...payload };
      if (world.dropAgreement) delete record.agreement;
      world.projects[600] = record;
      return jsonResponse(record);
    }
    if ((m = path.match(/^\/project\/projects\/(\d+)\/phases$/))) {
      if (world.phases === null) return notFound();
      return jsonResponse(world.phases[Number(m[1])] ?? []);
    }
    if ((m = path.match(/^\/project\/projects\/(\d+)$/))) {
      return world.projects[Number(m[1])] ? jsonResponse(world.projects[Number(m[1])]) : notFound();
    }

    if (path === "/project/tickets" && method === "POST") {
      const record: Rec = { id: 700, ...payload };
      if (world.dropPhase) delete record.phase;
      world.projectTickets[700] = record;
      return jsonResponse(record);
    }
    if ((m = path.match(/^\/project\/tickets\/(\d+)$/))) {
      const found = world.projectTickets[Number(m[1])];
      return found ? jsonResponse(found) : notFound();
    }
    if ((m = path.match(/^\/service\/tickets\/(\d+)$/))) {
      const found = world.serviceTickets[Number(m[1])];
      return found ? jsonResponse(found) : notFound();
    }

    if (path === "/time/entries" && method === "POST") {
      if (world.periodClosed && payload?.timeSheet) {
        return jsonResponse({ code: "ServerError", message: "An unexpected error occurred" }, 500);
      }
      if (world.periodClosed) {
        return jsonResponse(world.refusalBody ?? { code: "InvalidObject", message: LIVE_PERIOD_REFUSAL }, 400);
      }
      const record: Rec = { id: 800, ...payload };
      if (world.dropBillable) delete record.billableOption;
      world.timeEntries[800] = record;
      return jsonResponse(record);
    }
    if ((m = path.match(/^\/time\/entries\/(\d+)$/))) {
      const found = world.timeEntries[Number(m[1])];
      return found ? jsonResponse(found) : notFound();
    }

    if (path === "/company/companies/types") return jsonResponse(world.companyTypes);
    if (path === "/company/companyTypeAssociations" && method === "POST") {
      const company = (payload?.company as { id: number }).id;
      (world.associations[company] ??= []).push({ id: nextAssociation++, type: payload?.type });
      return jsonResponse({ id: nextAssociation - 1, ...payload });
    }
    if ((m = path.match(/^\/company\/companies\/(\d+)\/typeAssociations(?:\/(\d+))?$/))) {
      const company = Number(m[1]);
      const list = (world.associations[company] ??= []);
      if (method === "GET") {
        // The association's type carries the catalogue name, as ConnectWise returns it.
        return jsonResponse(
          list.map((a) => ({
            ...a,
            type: world.companyTypes.find((t) => t.id === (a.type as Rec).id) ?? a.type,
          })),
        );
      }
      if (method === "POST") {
        if (world.nestedPostStatus) {
          return jsonResponse({ code: "NotAllowed", message: "no" }, world.nestedPostStatus);
        }
        const record = { id: nextAssociation++, type: payload?.type };
        list.push(record);
        return jsonResponse(record);
      }
      if (method === "DELETE") {
        const id = Number(m[2]);
        world.associations[company] = list.filter((a) => a.id !== id);
        return jsonResponse(undefined, 204);
      }
    }
    if ((m = path.match(/^\/company\/companies\/(\d+)$/)) && method === "PATCH") {
      return jsonResponse({ id: Number(m[1]), patched: true });
    }

    return jsonResponse({ code: "NotFound", message: `Unexpected ${method} ${path}` }, 404);
  });

  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock, world, state_timeEntries: () => world.timeEntries };
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

afterEach(() => vi.unstubAllGlobals());

describe("cw_create_project", () => {
  const dates = { estimatedStart: "2026-11-02T00:00:00Z", estimatedEnd: "2026-11-30T00:00:00Z" };
  const base = { name: "WS3 test project", boardId: 4, companyId: 250, ...dates };
  const withoutDates = { name: "WS3 test project", boardId: 4, companyId: 250 };
  const billing = { billingMethod: "ActualRates", agreementId: 91 };

  it("requires estimatedStart and estimatedEnd in the tool schema", async () => {
    const tools = (
      await mcp<{ tools: { name: string; inputSchema: { required?: string[] } }[] }>("tools/list", {})
    ).result.tools;
    const tool = tools.find((t) => t.name === "cw_create_project")!;
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(["estimatedStart", "estimatedEnd"]));
  });

  it.each([
    ["no dates", {}],
    ["no end date", { estimatedStart: dates.estimatedStart }],
    ["no start date", { estimatedEnd: dates.estimatedEnd }],
    ["a blank start date", { ...dates, estimatedStart: "   " }],
    ["an empty end date", { ...dates, estimatedEnd: "" }],
    ["a start date that is not a date", { ...dates, estimatedStart: "next Tuesday" }],
  ])("refuses %s before any request, even with confirm: true", async (_label, extra) => {
    const cw = fakeConnectWise();

    const result = await call("cw_create_project", { ...withoutDates, ...billing, ...extra, confirm: true });

    expect(result.isError).toBe(true);
    expect(cw.fetchMock).not.toHaveBeenCalled();
  });

  it("sends both dates in the create body and in the planned body", async () => {
    const cw = fakeConnectWise();

    const plan = await call("cw_create_project", { ...base, ...billing });
    expect(body(plan)).toMatchObject({ saved: false, planned: dates });
    expect(cw.fetchMock).not.toHaveBeenCalled();

    const created = await call("cw_create_project", { ...base, ...billing, confirm: true });
    expect(created.isError).not.toBe(true);
    expect(cw.calls[0].body).toMatchObject(dates);
    expect(body(created)).toMatchObject({ project: dates });
  });

  it("requires billingMethod and agreementId, with no default", async () => {
    const tools = (
      await mcp<{ tools: { name: string; inputSchema: { required?: string[]; properties: Record<string, Rec> } }[] }>(
        "tools/list",
        {},
      )
    ).result.tools;
    const tool = tools.find((t) => t.name === "cw_create_project")!;
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(["billingMethod", "agreementId"]));
    expect(tool.inputSchema.properties.billingMethod).not.toHaveProperty("default");
    expect(tool.inputSchema.properties.agreementId).not.toHaveProperty("default");
    expect(tool.inputSchema.properties.billingMethod.enum).toEqual([
      "ActualRates",
      "FixedFee",
      "NotToExceed",
      "OverrideRate",
    ]);
  });

  it("refuses a call that leaves out the billing method or the agreement, with no request", async () => {
    const cw = fakeConnectWise();
    for (const args of [
      { ...base, agreementId: null, confirm: true },
      { ...base, billingMethod: "ActualRates", confirm: true },
      { ...base, billingMethod: "Hourly", agreementId: null, confirm: true },
    ]) {
      const result = await call("cw_create_project", args);
      expect(result.isError).toBe(true);
    }
    expect(cw.fetchMock).not.toHaveBeenCalled();
  });

  it("makes no write without confirm: true and returns the planned body", async () => {
    const cw = fakeConnectWise();

    const result = await call("cw_create_project", { ...base, billingMethod: "FixedFee", agreementId: 91, billingAmount: 500 });

    expect(result.isError).toBe(true);
    expect(cw.fetchMock).not.toHaveBeenCalled();
    expect(body(result)).toMatchObject({
      saved: false,
      planned: {
        name: "WS3 test project",
        board: { id: 4 },
        company: { id: 250 },
        billingMethod: "FixedFee",
        agreement: { id: 91 },
        billingAmount: 500,
      },
    });
  });

  it("creates the project with billing and agreement, then reads it back", async () => {
    const cw = fakeConnectWise();

    const result = await call("cw_create_project", {
      ...base,
      billingMethod: "FixedFee",
      agreementId: 91,
      billingAmount: 500,
      confirm: true,
    });

    expect(result.isError).not.toBe(true);
    expect(body(result)).toMatchObject({
      saved: true,
      verified: true,
      project: { id: 600, billingMethod: "FixedFee", agreement: { id: 91 }, billingAmount: 500 },
    });
    expect(cw.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /project/projects",
      "GET /project/projects/600",
    ]);
    expect(cw.calls[0].body).toMatchObject({ billingMethod: "FixedFee", agreement: { id: 91 } });
  });

  it("sends no agreement when agreementId is null, and still verifies", async () => {
    const cw = fakeConnectWise();

    const result = await call("cw_create_project", {
      ...base,
      billingMethod: "ActualRates",
      agreementId: null,
      confirm: true,
    });

    expect(cw.calls[0].body).not.toHaveProperty("agreement");
    expect(body(result)).toMatchObject({ verified: true, project: { agreement: null } });
  });

  it("reports an agreement the fresh read does not hold", async () => {
    fakeConnectWise({ dropAgreement: true });

    const result = await call("cw_create_project", {
      ...base,
      billingMethod: "ActualRates",
      agreementId: 91,
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({ saved: true, verified: false, mismatches: ["agreement"] });
  });
});

describe("cw_list_project_phases and cw_create_project_ticket", () => {
  const phases = { 600: [{ id: 31, description: "Plan", status: { id: 1, name: "Open" } }, { id: 32, description: "Build" }] };
  const args = { projectId: 600, phaseId: 31, summary: "WS3 test project ticket" };

  it("lists a project's phases lean", async () => {
    fakeConnectWise({ phases });
    const result = await call("cw_list_project_phases", { projectId: 600 });
    expect(body(result)).toEqual({
      projectId: 600,
      count: 2,
      phases: [
        { id: 31, description: "Plan", status: { id: 1, name: "Open" } },
        { id: 32, description: "Build", status: null },
      ],
    });
  });

  it("makes no write without confirm: true", async () => {
    const cw = fakeConnectWise({ phases });
    const result = await call("cw_create_project_ticket", args);
    expect(result.isError).toBe(true);
    expect(writes(cw.calls)).toEqual([]);
    expect(body(result)).toMatchObject({
      saved: false,
      planned: { summary: "WS3 test project ticket", project: { id: 600 }, phase: { id: 31 } },
    });
  });

  it("refuses a phase that is not a phase of the project", async () => {
    const cw = fakeConnectWise({ phases });
    const result = await call("cw_create_project_ticket", { ...args, phaseId: 99, confirm: true });
    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({ refused: true, phaseIds: [31, 32] });
    expect(writes(cw.calls)).toEqual([]);
  });

  it("creates the ticket on the phase and reads it back", async () => {
    const cw = fakeConnectWise({ phases });

    const result = await call("cw_create_project_ticket", {
      ...args,
      statusId: 5,
      budgetHours: 2,
      confirm: true,
    });

    expect(result.isError).not.toBe(true);
    expect(body(result)).toMatchObject({
      saved: true,
      verified: true,
      ticket: { id: 700, summary: "WS3 test project ticket", project: { id: 600 }, phase: { id: 31 } },
    });
    const post = cw.calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe("/project/tickets");
    expect(post.body).toEqual({
      summary: "WS3 test project ticket",
      project: { id: 600 },
      phase: { id: 31 },
      status: { id: 5 },
      budgetHours: 2,
    });
    expect(cw.calls.at(-1)).toMatchObject({ method: "GET", path: "/project/tickets/700" });
  });

  it("still writes when the phase list cannot be read, because ConnectWise validates the phase", async () => {
    const cw = fakeConnectWise({ phases: null });
    const result = await call("cw_create_project_ticket", { ...args, confirm: true });
    expect(body(result)).toMatchObject({ saved: true, verified: true });
    expect(cw.calls.some((c) => c.method === "POST")).toBe(true);
  });

  it("reports a phase the fresh read does not hold", async () => {
    fakeConnectWise({ phases, dropPhase: true });
    const result = await call("cw_create_project_ticket", { ...args, confirm: true });
    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({ verified: false, mismatches: ["phase"] });
  });
});

describe("cw_create_time_entry", () => {
  const entry = {
    chargeToType: "ServiceTicket",
    chargeToId: 77,
    memberId: 20,
    timeStart: "2026-10-12T02:00:00Z",
    actualHours: 0.25,
    confirm: true,
  };
  const openTicket = { 77: { id: 77, closedFlag: false } };

  it("makes no write without confirm: true and returns the planned body", async () => {
    const cw = fakeConnectWise({ serviceTickets: openTicket });

    const { confirm: _confirm, ...unconfirmed } = entry;
    const result = await call("cw_create_time_entry", { ...unconfirmed, billableOption: "NoCharge" });

    expect(result.isError).toBe(true);
    expect(writes(cw.calls)).toEqual([]);
    expect(body(result)).toMatchObject({
      saved: false,
      planned: { chargeToType: "ServiceTicket", chargeToId: 77, billableOption: "NoCharge" },
    });
    expect(cw.state_timeEntries()).toEqual({});
  });

  it("reports a closed ticket before it asks for confirmation", async () => {
    fakeConnectWise({ serviceTickets: { 77: { id: 77, closedFlag: true } } });
    const { confirm: _confirm, ...unconfirmed } = entry;
    const result = await call("cw_create_time_entry", unconfirmed);
    expect(body(result)).toMatchObject({ reason: "ticket-closed" });
  });

  it("sets billableOption at creation and reads the entry back", async () => {
    const cw = fakeConnectWise({ serviceTickets: openTicket });

    const result = await call("cw_create_time_entry", { ...entry, billableOption: "NoCharge" });

    expect(result.isError).not.toBe(true);
    expect(body(result)).toMatchObject({ id: 800, billableOption: "NoCharge", verified: { billableOption: true } });
    const post = cw.calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({ billableOption: "NoCharge" });
    // Created with the option. No patch.
    expect(cw.calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("sends emailContactFlag false unless it is passed as true, so no contact is emailed by accident", async () => {
    const cw = fakeConnectWise({ serviceTickets: openTicket });

    await call("cw_create_time_entry", entry);
    await call("cw_create_time_entry", { ...entry, emailContactFlag: false });
    await call("cw_create_time_entry", { ...entry, emailContactFlag: true });

    const posts = cw.calls.filter((c) => c.method === "POST").map((c) => (c.body as Rec).emailContactFlag);
    expect(posts).toEqual([false, false, true]);
  });

  it("shows emailContactFlag false in the plan when it is not passed", async () => {
    fakeConnectWise({ serviceTickets: openTicket });
    const { confirm: _confirm, ...noConfirm } = entry as Rec;

    const result = await call("cw_create_time_entry", noConfirm);

    expect(body(result)).toMatchObject({ saved: false, planned: { emailContactFlag: false } });
  });

  it("passes the time sheet as timeSheet.id", async () => {
    const cw = fakeConnectWise({ serviceTickets: openTicket });

    const result = await call("cw_create_time_entry", { ...entry, timeSheetId: 4321 });

    expect(cw.calls.find((c) => c.method === "POST")!.body).toMatchObject({ timeSheet: { id: 4321 } });
    expect(body(result)).toMatchObject({ verified: { timeSheet: true } });
  });

  it("returns the created entry as before when neither new option is used", async () => {
    const cw = fakeConnectWise({ serviceTickets: openTicket });

    const result = await call("cw_create_time_entry", entry);

    expect(body(result)).toMatchObject({ id: 800, chargeToId: 77 });
    expect(body(result)).not.toHaveProperty("verified");
    expect(cw.calls.map((c) => c.method)).toEqual(["GET", "POST"]);
  });

  it("reports a billableOption the fresh read does not hold", async () => {
    fakeConnectWise({ serviceTickets: openTicket, dropBillable: true });
    const result = await call("cw_create_time_entry", { ...entry, billableOption: "DoNotBill" });
    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({ verified: { billableOption: false } });
  });

  it("explains a time period that is not open and gives the supported way to add the time", async () => {
    fakeConnectWise({ serviceTickets: openTicket, periodClosed: true });

    const result = await call("cw_create_time_entry", entry);

    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({ saved: false, reason: "time-period-not-open" });
    const message = String(body(result).message);
    // It no longer tells the caller to pass timeSheetId: the live server refuses that too.
    expect(message).toMatch(/Passing timeSheetId does not get around that/);
    expect(message).toMatch(/reverse it with cw_reverse_time_sheet.*create the entry.*cw_submit_time_sheet.*cw_approve_time_sheet/);
  });

  it("matches ConnectWise's exact wording, which has 25 characters between 'time period' and 'not open'", async () => {
    fakeConnectWise({ serviceTickets: openTicket, periodClosed: true });

    const result = await call("cw_create_time_entry", entry);

    // The pattern before this fix, which allowed 20 characters. It cannot see this text.
    expect(/time period.{0,20}not open/i.test(LIVE_PERIOD_REFUSAL)).toBe(false);
    expect(result.isError).toBe(true);
    const out = body(result);
    expect(out).toMatchObject({ saved: false, reason: "time-period-not-open" });
    // Reshaped by the tool, not the raw upstream text.
    expect(JSON.stringify(out)).not.toContain("returned 400");
    expect(JSON.stringify(out)).not.toContain(LIVE_PERIOD_REFUSAL);
  });

  it("matches the wording when it arrives in a field error rather than the top message", async () => {
    fakeConnectWise({
      serviceTickets: openTicket,
      periodClosed: true,
      refusalBody: {
        code: "InvalidObject",
        message: "Validation failed.",
        errors: [{ code: "InvalidObject", message: LIVE_PERIOD_REFUSAL, field: "timeStart" }],
      },
    });

    const result = await call("cw_create_time_entry", entry);

    expect(body(result)).toMatchObject({ saved: false, reason: "time-period-not-open" });
  });

  it("passes any other 400 through raw, and does not call it a closed period", async () => {
    fakeConnectWise({
      serviceTickets: openTicket,
      periodClosed: true,
      refusalBody: { code: "InvalidObject", message: "Time period specified is invalid." },
    });

    const result = await call("cw_create_time_entry", entry);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/returned 400/);
    expect(result.content[0].text).not.toMatch(/time-period-not-open/);
  });

  it("names the 500 ConnectWise gives when timeSheetId points at a sheet that is not Open", async () => {
    const cw = fakeConnectWise({ serviceTickets: openTicket, periodClosed: true });

    const result = await call("cw_create_time_entry", { ...entry, timeSheetId: 4321 });

    expect(result.isError).toBe(true);
    const out = body(result);
    expect(out).toMatchObject({ saved: false, reason: "time-sheet-not-open", timeSheetId: 4321 });
    const message = String(out.message);
    expect(message).toMatch(/answered 500 to an entry with timeSheetId 4321/);
    expect(message).toMatch(/reverse it with cw_reverse_time_sheet/);
    // The reference stays, so the call can be found in the log. The upstream body does not.
    expect(message).toMatch(/returned 500 \(reference /);
    expect(message).not.toContain("An unexpected error occurred");
    expect(cw.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("does not rename a 500 on an entry that passed no timeSheetId", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init: RequestInit = {}) =>
        init.method === "POST"
          ? jsonResponse({ code: "ServerError", message: "boom" }, 500)
          : jsonResponse({ id: 77, closedFlag: false }),
      ),
    );

    const result = await call("cw_create_time_entry", entry);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/returned 500/);
    expect(result.content[0].text).not.toMatch(/time-sheet-not-open/);
  });

  it.each([
    ["service", { chargeToType: "ServiceTicket" }, { serviceTickets: { 77: { id: 77, closedFlag: true } } }],
    ["project", { chargeToType: "ProjectTicket" }, { projectTickets: { 77: { id: 77, closedFlag: true } } }],
  ])("reports a closed %s ticket plainly and never reopens it", async (_kind, args, world) => {
    const cw = fakeConnectWise(world);

    const result = await call("cw_create_time_entry", { ...entry, ...args });

    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({ saved: false, reason: "ticket-closed" });
    expect(String(body(result).message)).toMatch(/not reopened/);
    expect(writes(cw.calls)).toEqual([]);
  });

  it("does not look up a ticket for a charge code", async () => {
    const cw = fakeConnectWise();
    await call("cw_create_time_entry", { ...entry, chargeToType: "ChargeCode", chargeToId: 5 });
    expect(cw.calls.map((c) => c.method)).toEqual(["POST"]);
  });
});

describe("company types through typeAssociations", () => {
  const catalogue = [
    { id: 1, name: "Client" },
    { id: 2, name: "Supplier" },
    { id: 3, name: "Prospect" },
  ];

  it("recognises a patch on types or typeIds", () => {
    expect(companyPatchTouchesTypes("types")).toBe(true);
    expect(companyPatchTouchesTypes("/types/0")).toBe(true);
    expect(companyPatchTouchesTypes("typeIds")).toBe(true);
    expect(companyPatchTouchesTypes("name")).toBe(false);
  });

  it("cw_update_company refuses a type patch and passes any other", async () => {
    const cw = fakeConnectWise();

    const refused = await call("cw_update_company", {
      id: 250,
      operations: [{ op: "add", path: "types", value: [{ id: 1 }] }],
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/cw_add_company_type_association/);
    expect(cw.fetchMock).not.toHaveBeenCalled();

    const ok = await call("cw_update_company", {
      id: 250,
      operations: [{ op: "replace", path: "name", value: "Future Logic" }],
    });
    expect(ok.isError).not.toBe(true);
    expect(cw.calls).toHaveLength(1);
  });

  it("lists the company type catalogue", async () => {
    fakeConnectWise({ companyTypes: catalogue });
    const result = await call("cw_list_company_types", {});
    expect(body(result)).toEqual({
      count: 3,
      types: [
        { id: 1, name: "Client" },
        { id: 2, name: "Supplier" },
        { id: 3, name: "Prospect" },
      ],
    });
  });

  it("lists the types a company holds", async () => {
    fakeConnectWise({
      companyTypes: catalogue,
      associations: { 250: [{ id: 41, type: { id: 1 } }] },
    });
    const result = await call("cw_list_company_type_associations", { companyId: 250 });
    expect(body(result)).toEqual({
      companyId: 250,
      count: 1,
      associations: [{ associationId: 41, typeId: 1, typeName: "Client" }],
    });
  });

  it("is registered read-only for the list and destructive for the remove", async () => {
    const tools = (await mcp<{ tools: { name: string; annotations?: Rec }[] }>("tools/list", {})).result.tools;
    const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(by.cw_list_company_type_associations).toMatchObject({ readOnlyHint: true });
    expect(by.cw_add_company_type_association).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(by.cw_remove_company_type_association).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  describe("add", () => {
    it("makes no write without confirm: true", async () => {
      const cw = fakeConnectWise({ companyTypes: catalogue });
      const result = await call("cw_add_company_type_association", { companyId: 250, typeName: "supplier" });
      expect(result.isError).toBe(true);
      expect(body(result)).toMatchObject({ added: false, planned: { type: { id: 2, name: "Supplier" } } });
      expect(writes(cw.calls)).toEqual([]);
    });

    it("adds the type by name, through the nested path, and reads it back", async () => {
      const cw = fakeConnectWise({ companyTypes: catalogue });

      const result = await call("cw_add_company_type_association", {
        companyId: 250,
        typeName: "Supplier",
        confirm: true,
      });

      expect(result.isError).not.toBe(true);
      expect(body(result)).toMatchObject({
        added: true,
        verified: true,
        via: "/company/companies/250/typeAssociations",
        association: { typeId: 2, typeName: "Supplier" },
      });
      const post = cw.calls.find((c) => c.method === "POST")!;
      expect(post.path).toBe("/company/companies/250/typeAssociations");
      expect(post.body).toEqual({ type: { id: 2 }, company: { id: 250 } });
      expect(cw.calls.at(-1)).toMatchObject({ method: "GET", path: "/company/companies/250/typeAssociations" });
    });

    it("falls back to the top-level collection when the nested POST is not allowed", async () => {
      const cw = fakeConnectWise({ companyTypes: catalogue, nestedPostStatus: 405 });

      const result = await call("cw_add_company_type_association", {
        companyId: 250,
        typeId: 3,
        confirm: true,
      });

      expect(body(result)).toMatchObject({ added: true, via: "/company/companyTypeAssociations" });
      expect(cw.calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
        "/company/companies/250/typeAssociations",
        "/company/companyTypeAssociations",
      ]);
    });

    it("does not retry a 403", async () => {
      const cw = fakeConnectWise({ companyTypes: catalogue, nestedPostStatus: 403 });
      const result = await mcp("tools/call", {
        name: "cw_add_company_type_association",
        arguments: { companyId: 250, typeId: 3, confirm: true },
      });
      expect(JSON.stringify(result)).toMatch(/403/);
      expect(cw.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    });

    it("reports a type the company already holds and writes nothing", async () => {
      const cw = fakeConnectWise({
        companyTypes: catalogue,
        associations: { 250: [{ id: 41, type: { id: 1 } }] },
      });
      const result = await call("cw_add_company_type_association", {
        companyId: 250,
        typeName: "Client",
        confirm: true,
      });
      expect(result.isError).not.toBe(true);
      expect(body(result)).toMatchObject({ added: false, alreadyPresent: true });
      expect(writes(cw.calls)).toEqual([]);
    });

    it("refuses an unknown or ambiguous type name", async () => {
      fakeConnectWise({ companyTypes: [...catalogue, { id: 9, name: "client" }] });
      const unknown = await call("cw_add_company_type_association", { companyId: 250, typeName: "Nope", confirm: true });
      expect(String(body(unknown).message)).toMatch(/No company type named "Nope"/);
      const ambiguous = await call("cw_add_company_type_association", { companyId: 250, typeName: "Client", confirm: true });
      expect(String(body(ambiguous).message)).toMatch(/More than one company type/);
    });
  });

  describe("remove", () => {
    const held = { 250: [{ id: 41, type: { id: 1 } }, { id: 42, type: { id: 2 } }] };

    it("makes no write without confirm: true and returns what would go", async () => {
      const cw = fakeConnectWise({ companyTypes: catalogue, associations: held });
      const result = await call("cw_remove_company_type_association", { companyId: 250, typeName: "Supplier" });
      expect(result.isError).toBe(true);
      expect(body(result)).toMatchObject({
        removed: false,
        planned: [{ associationId: 42, typeId: 2, typeName: "Supplier" }],
      });
      expect(writes(cw.calls)).toEqual([]);
    });

    it("lists first, deletes only the matching association and reads the company back", async () => {
      const cw = fakeConnectWise({ companyTypes: catalogue, associations: held });

      const result = await call("cw_remove_company_type_association", {
        companyId: 250,
        typeName: "Supplier",
        confirm: true,
      });

      expect(result.isError).not.toBe(true);
      expect(body(result)).toMatchObject({
        removed: true,
        verified: true,
        removedAssociationIds: [42],
        types: [{ associationId: 41, typeName: "Client" }],
      });
      const sequence = cw.calls.map((c) => `${c.method} ${c.path}`);
      expect(sequence).toEqual([
        "GET /company/companies/250/typeAssociations",
        "DELETE /company/companies/250/typeAssociations/42",
        "GET /company/companies/250/typeAssociations",
      ]);
    });

    it("removes by association id", async () => {
      const cw = fakeConnectWise({ companyTypes: catalogue, associations: held });
      const result = await call("cw_remove_company_type_association", {
        companyId: 250,
        associationId: 41,
        confirm: true,
      });
      expect(body(result)).toMatchObject({ removed: true, removedAssociationIds: [41] });
      expect(cw.calls.some((c) => c.method === "DELETE" && c.path.endsWith("/41"))).toBe(true);
    });

    it("refuses when the company holds no matching type and deletes nothing", async () => {
      const cw = fakeConnectWise({ companyTypes: catalogue, associations: held });
      const result = await call("cw_remove_company_type_association", {
        companyId: 250,
        typeName: "Prospect",
        confirm: true,
      });
      expect(result.isError).toBe(true);
      expect(body(result)).toMatchObject({ removed: false, refused: true });
      expect(writes(cw.calls)).toEqual([]);
    });

    it("needs one of associationId, typeId or typeName", async () => {
      const cw = fakeConnectWise({});
      const result = await call("cw_remove_company_type_association", { companyId: 250, confirm: true });
      expect(result.isError).toBe(true);
      expect(cw.fetchMock).not.toHaveBeenCalled();
    });
  });
});

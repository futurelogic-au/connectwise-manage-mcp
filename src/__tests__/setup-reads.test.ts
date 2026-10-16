/**
 * Tests for the setup read tools and the ticket routing trace.
 *
 * The tools are driven through the Worker's MCP endpoint in gateway mode, so
 * the registration, the input schema and the outbound request are all covered.
 * ConnectWise is a fake that answers from a table of paths.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../worker.js";
import {
  evaluateEventCondition,
  findArrivedOwner,
  findOwnerCandidates,
  readAuditFacts,
  toBoardAssignment,
  toLeanBoardStatus,
  toRef,
  type RoutingEvidence,
} from "../tools/setup.js";

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
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
}

/**
 * Fake ConnectWise: answers a GET from a table of paths. A value that is a
 * number is answered as that HTTP status. Its code and message may reach the
 * caller (a 403 names the missing permission); its other fields must not. A path that is not in the table answers 404.
 */
function fakeConnectWise(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname.replace("/v4_6_release/apis/3.0", "");
    calls.push({
      method: String(init.method ?? "GET"),
      path,
      query: Object.fromEntries(parsed.searchParams.entries()),
    });
    if (!(path in routes)) return jsonResponse({ code: "NotFound", message: `Unexpected ${path}` }, 404);
    const answer = routes[path];
    if (typeof answer === "number") {
      return jsonResponse({ code: "Forbidden", message: "No permission", trace: "SECRET upstream body" }, answer);
    }
    // A collection answers page one only, as a short page ends the paging.
    if (Array.isArray(answer) && parsed.searchParams.get("page") !== "1") return jsonResponse([]);
    return jsonResponse(answer);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

const SETUP_TOOLS = [
  "cw_get_board",
  "cw_list_board_teams",
  "cw_get_board_team",
  "cw_list_board_statuses",
  "cw_get_board_status",
  "cw_list_board_types",
  "cw_get_board_type",
  "cw_get_board_subtype",
  "cw_list_workflow_rules",
  "cw_get_workflow_rule",
  "cw_list_email_connectors",
  "cw_get_email_connector",
  "cw_list_slas",
  "cw_get_sla",
  "cw_trace_ticket_routing",
];

const nathan = { id: 12, identifier: "NColyer", name: "Nathan Colyer-Long" };
const priya = { id: 31, identifier: "PShah", name: "Priya Shah" };

/** An event condition in the form ConnectWise holds it: one JSON object per term. */
const CONDITION =
  '{"id":1,"triggerId":19,"value":{"value":"15","description":"Priority 2 - High"},"description":"Priority is {value}"}' +
  ' and {"id":2,"triggerId":33,"value":{"value":"40","description":"New"},"description":"Ticket is in {value} status"}';

/** The setup behind one ticket: board 5, team 9 led by Nathan, one connector, one rule. */
function routingRoutes(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "/service/tickets/700": {
      id: 700,
      summary: "Printer offline",
      board: { id: 5, name: "Service Desk" },
      team: { id: 9, name: "Level 1" },
      owner: priya,
      status: { id: 40, name: "New" },
      priority: { id: 15, name: "Priority 2 - High" },
      closedFlag: false,
      company: { id: 250, identifier: "FLHQ", name: "Future Logic" },
      source: { id: 2, name: "Email Connector" },
      initialDescription: "A long body the trace must not return",
      _info: { dateEntered: "2026-10-01T01:00:00Z", enteredBy: "PShah", lastUpdated: "2026-10-01T01:05:00Z" },
    },
    // Newest first, as ConnectWise returns it. The literal backslash-n is how the API sends the line break.
    "/system/audittrail": [
      { text: 'Status has been updated from "New" to "Assigned".', enteredBy: "Priya Shah", enteredDate: "2026-10-01T03:30:00Z", auditType: "Tickets", auditSubType: "Status" },
      { text: 'Owner has been updated from "Nathan Colyer-Long" to "Priya Shah".', enteredBy: "Stephan Jenner", enteredDate: "2026-10-01T03:00:00Z", auditType: "Resource", auditSubType: "Owner" },
      { text: 'Workflow "Assign new tickets" ran on this ticket. EventID: "77".', enteredBy: "CW Service", enteredDate: "2026-10-01T02:00:00Z", auditType: "Workflow", auditSubType: "Match" },
      { text: 'Workflow "Assign new tickets" ran on this ticket. EventID: "77".', enteredBy: "CW Service", enteredDate: "2026-10-01T01:30:00Z", auditType: "Workflow", auditSubType: "Match" },
      { text: "New Ticket #700 has been created.", enteredBy: "Email Connector", enteredDate: "2026-10-01T01:00:00Z", auditType: "Record", auditSubType: "Created" },
      { text: "New schedule record added by service board automatic assignment.\n Member: Priya Shah", enteredBy: "autoassign", enteredDate: "2026-10-01T01:00:00Z", auditType: "Resource", auditSubType: "Record" },
      { text: "New schedule record added by service board automatic assignment.\n Member: Nathan Colyer-Long", enteredBy: "autoassign", enteredDate: "2026-10-01T01:00:00Z", auditType: "Resource", auditSubType: "Record" },
    ],
    "/service/boards/5": {
      id: 5,
      name: "Service Desk",
      inactiveFlag: false,
      autoAssignNewTicketsFlag: true,
      autoAssignTicketOwnerFlag: true,
      dispatchMember: priya,
      notifyEmailFrom: "desk@example.test",
    },
    "/service/boards/5/autoAssignResources": [{ id: 1, notifyWho: { id: 7, identifier: "T", name: "All Team Members" } }],
    "/service/boards/5/teams": [
      { id: 9, name: "Level 1", boardId: 5, defaultFlag: true, roundRobinFlag: true, teamLeader: nathan, members: [12, 31] },
      { id: 10, name: "Level 2", boardId: 5, defaultFlag: false, teamLeader: priya, members: [31] },
    ],
    "/system/members": [
      { id: 12, identifier: "NColyer", firstName: "Nathan", lastName: "Colyer-Long", inactiveFlag: false },
      { id: 31, identifier: "PShah", firstName: "Priya", lastName: "Shah", inactiveFlag: false },
    ],
    "/system/emailConnectors": [
      {
        id: 3,
        emailServerType: "Office365",
        office365EmailSetup: { id: 1, name: "desk@example.test" },
        serviceBoard: { id: 5, name: "Service Desk" },
        defaultMember: nathan,
        emailErrorsTo: "errors@example.test",
      },
    ],
    "/system/workflows": [
      { id: 21, name: "Assign new tickets", activateFlag: true, tableType: { id: 1, name: "Service Tickets" }, board: { id: 5, name: "Service Desk" } },
    ],
    "/system/workflows/21/events": [
      { id: 77, name: "On create", eventCondition: CONDITION, frequencyUnit: "Minutes" },
    ],
    "/system/workflows/21/events/77/actions": [
      { id: 88, notifyType: { id: 4, name: "Assign Member" }, specificMemberTo: nathan, updateOwnerFlag: true, notes: "<html>body</html>" },
      { id: 89, notifyType: { id: 5, name: "Send Email" }, specificMemberTo: priya },
    ],
    ...over,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("setup read tools, registration", () => {
  it("registers every setup tool as read-only", async () => {
    const tools = (await mcp<{ tools: ListedTool[] }>("tools/list", {})).result.tools;
    for (const name of SETUP_TOOLS) {
      const tool = tools.find((entry) => entry.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.annotations, name).toMatchObject({ readOnlyHint: true });
      expect(tool!.inputSchema.properties, name).not.toHaveProperty("confirm");
    }
  });

  it("registers no write tool on a setup table", async () => {
    const tools = (await mcp<{ tools: ListedTool[] }>("tools/list", {})).result.tools;
    const writes = tools
      .map((tool) => tool.name)
      .filter((name) =>
        /^cw_(create|update|delete|add|remove)_.*(board|workflow|email_connector|sla|status|team)/.test(name),
      );
    expect(writes).toEqual([]);
  });

  it("sends only GET requests from every setup tool", async () => {
    const cw = fakeConnectWise(
      routingRoutes({
        "/service/boards/5/statuses": [],
        "/service/boards/5/statuses/40": { id: 40 },
        "/service/boards/5/teams/9": { id: 9, name: "Level 1", members: [] },
        "/service/boards/5/types": [],
        "/service/boards/5/types/1": { id: 1 },
        "/service/boards/5/subtypes": [],
        "/service/boards/5/subtypes/2": { id: 2 },
        "/system/workflows/21": { id: 21, name: "Assign new tickets" },
        "/system/emailConnectors/3": { id: 3 },
        "/system/emailConnectors/3/parsingStyles": [],
        "/service/slas": [],
        "/service/slas/1": { id: 1, name: "Standard" },
        "/service/slas/1/priorities": [],
      }),
    );
    const args: Record<string, unknown> = {
      cw_get_board: { id: 5 },
      cw_list_board_teams: { boardId: 5 },
      cw_get_board_team: { boardId: 5, teamId: 9 },
      cw_list_board_statuses: { boardId: 5 },
      cw_get_board_status: { boardId: 5, statusId: 40 },
      cw_list_board_types: { boardId: 5 },
      cw_get_board_type: { boardId: 5, typeId: 1 },
      cw_get_board_subtype: { boardId: 5, subtypeId: 2 },
      cw_list_workflow_rules: {},
      cw_get_workflow_rule: { id: 21 },
      cw_list_email_connectors: {},
      cw_get_email_connector: { id: 3 },
      cw_list_slas: {},
      cw_get_sla: { id: 1 },
      cw_trace_ticket_routing: { ticketId: 700 },
    };
    for (const name of SETUP_TOOLS) {
      const result = await call(name, args[name]);
      expect(result.isError, name).not.toBe(true);
    }
    expect(cw.calls.length).toBeGreaterThan(SETUP_TOOLS.length);
    expect(cw.calls.filter((entry) => entry.method !== "GET")).toEqual([]);
  }, 20000);
});

describe("boards, teams, statuses and types", () => {
  it("cw_get_board returns the board record with its auto-assign resources", async () => {
    const cw = fakeConnectWise(routingRoutes());
    const out = json(await call("cw_get_board", { id: 5 }));
    expect(out.board).toMatchObject({ id: 5, autoAssignNewTicketsFlag: true, dispatchMember: priya });
    expect(out.autoAssignResources).toEqual([{ id: 1, notifyWho: { id: 7, identifier: "T", name: "All Team Members" } }]);
    expect(cw.calls.map((entry) => entry.path)).toEqual([
      "/service/boards/5",
      "/service/boards/5/autoAssignResources",
    ]);
  });

  it("cw_list_board_teams names the default team, the leader and each member", async () => {
    const cw = fakeConnectWise(routingRoutes());
    const out = json(await call("cw_list_board_teams", { boardId: 5 })) as {
      count: number;
      teams: Array<Record<string, unknown>>;
    };
    expect(out.count).toBe(2);
    expect(out.teams[0]).toMatchObject({
      id: 9,
      name: "Level 1",
      defaultFlag: true,
      roundRobinFlag: true,
      teamLeader: nathan,
      members: [
        { id: 12, identifier: "NColyer", name: "Nathan Colyer-Long", inactiveFlag: false },
        { id: 31, identifier: "PShah", name: "Priya Shah", inactiveFlag: false },
      ],
    });
    expect(out.teams[1]).toMatchObject({ id: 10, defaultFlag: false, teamLeader: priya });
    // Member ids are resolved in one request, each id asked for once.
    const memberCalls = cw.calls.filter((entry) => entry.path === "/system/members");
    expect(memberCalls).toHaveLength(1);
    expect(memberCalls[0].query.conditions).toBe("id in (12,31)");
  });

  it("cw_list_board_teams keeps a member id that ConnectWise did not return, with no name", async () => {
    fakeConnectWise(routingRoutes({ "/system/members": [] }));
    const out = json(await call("cw_list_board_teams", { boardId: 5 })) as {
      teams: Array<{ members: unknown[] }>;
    };
    expect(out.teams[0].members).toEqual([
      { id: 12, identifier: null, name: null, inactiveFlag: null },
      { id: 31, identifier: null, name: null, inactiveFlag: null },
    ]);
  });

  it("cw_get_board_team reads the nested team path", async () => {
    const cw = fakeConnectWise(
      routingRoutes({ "/service/boards/5/teams/9": { id: 9, name: "Level 1", teamLeader: nathan, members: [12] } }),
    );
    const out = json(await call("cw_get_board_team", { boardId: 5, teamId: 9 }));
    expect(out).toMatchObject({ id: 9, teamLeader: nathan, members: [{ id: 12, identifier: "NColyer" }] });
    expect(cw.calls[0].path).toBe("/service/boards/5/teams/9");
  });

  const statuses = [
    { id: 3, name: "Closed", closedStatus: true, inactive: false, escalationStatus: "Resolved", sortOrder: 30, board: { id: 5 } },
    { id: 1, name: "New", closedStatus: false, inactive: false, escalationStatus: "NotResponded", defaultFlag: true, sortOrder: 10 },
    { id: 2, name: "Old", closedStatus: false, inactive: true, escalationStatus: "Responded", sortOrder: 20 },
  ];

  it("cw_list_board_statuses returns the closed, inactive and escalation flags in sort order", async () => {
    fakeConnectWise({ "/service/boards/5/statuses": statuses });
    const out = json(await call("cw_list_board_statuses", { boardId: 5 })) as {
      count: number;
      statuses: Array<Record<string, unknown>>;
    };
    expect(out.count).toBe(3);
    expect(out.statuses.map((status) => status.name)).toEqual(["New", "Old", "Closed"]);
    expect(out.statuses[2]).toEqual({
      id: 3,
      name: "Closed",
      closedStatus: true,
      inactive: false,
      escalationStatus: "Resolved",
      sortOrder: 30,
    });
  });

  it("cw_list_board_statuses leaves out inactive statuses only when asked", async () => {
    fakeConnectWise({ "/service/boards/5/statuses": statuses });
    const out = json(await call("cw_list_board_statuses", { boardId: 5, includeInactive: false })) as {
      statuses: Array<Record<string, unknown>>;
    };
    expect(out.statuses.map((status) => status.name)).toEqual(["New", "Closed"]);
  });

  it("cw_list_board_types returns types and subtypes with their links", async () => {
    const cw = fakeConnectWise({
      "/service/boards/5/types": [{ id: 1, name: "Incident", inactiveFlag: false, category: "Reactive", board: { id: 5 } }],
      "/service/boards/5/subtypes": [{ id: 2, name: "Printer", inactiveFlag: true, typeAssociationIds: [1] }],
    });
    const out = json(await call("cw_list_board_types", { boardId: 5 }));
    expect(out).toEqual({
      boardId: 5,
      typeCount: 1,
      subtypeCount: 1,
      types: [{ id: 1, name: "Incident", inactiveFlag: false, category: "Reactive" }],
      subtypes: [{ id: 2, name: "Printer", inactiveFlag: true, typeAssociationIds: [1] }],
    });
    expect(cw.calls.map((entry) => entry.path)).toEqual(["/service/boards/5/types", "/service/boards/5/subtypes"]);
  });

  it("refuses a board id that is not a positive whole number before any request", async () => {
    const cw = fakeConnectWise({});
    for (const boardId of [0, -1, 1.5, "5"]) {
      expect((await call("cw_list_board_teams", { boardId })).isError).toBe(true);
    }
    expect(cw.fetchMock).not.toHaveBeenCalled();
  });

  it("reports an upstream failure with the status and a reference, never the whole body", async () => {
    fakeConnectWise({ "/service/boards/5/statuses": 403 });
    const result = await call("cw_list_board_statuses", { boardId: 5 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/returned 403 \(reference /);
    expect(result.content[0].text).not.toContain("SECRET");
  });
});

describe("workflow rules, email connectors and SLAs", () => {
  it("cw_list_workflow_rules filters by board and active state", async () => {
    const cw = fakeConnectWise(routingRoutes());
    const out = json(await call("cw_list_workflow_rules", { boardId: 5, activeOnly: true })) as {
      rules: unknown[];
    };
    expect(out.rules).toEqual([
      {
        id: 21,
        name: "Assign new tickets",
        activateFlag: true,
        tableType: { id: 1, name: "Service Tickets" },
        board: { id: 5, name: "Service Desk" },
      },
    ]);
    expect(cw.calls[0].query.conditions).toBe("(board/id=5) and (activateFlag=true)");
  });

  it("cw_list_workflow_rules sends no conditions when none are asked for", async () => {
    const cw = fakeConnectWise(routingRoutes());
    await call("cw_list_workflow_rules", {});
    expect(cw.calls[0].query).not.toHaveProperty("conditions");
  });

  it("cw_get_workflow_rule returns each event with its condition and its actions", async () => {
    const cw = fakeConnectWise(routingRoutes({ "/system/workflows/21": { id: 21, name: "Assign new tickets" } }));
    const out = json(await call("cw_get_workflow_rule", { id: 21 })) as {
      events: Array<{ eventCondition: string; actions: Array<Record<string, unknown>> }>;
    };
    expect(out).toMatchObject({ id: 21, name: "Assign new tickets" });
    expect(out.events).toHaveLength(1);
    expect(out.events[0].eventCondition).toBe(CONDITION);
    expect(out.events[0].actions.map((action) => action.id)).toEqual([88, 89]);
    expect(cw.calls.map((entry) => entry.path)).toEqual([
      "/system/workflows/21",
      "/system/workflows/21/events",
      "/system/workflows/21/events/77/actions",
    ]);
  });

  it("cw_list_email_connectors shows the board and default member, filtered by board", async () => {
    const cw = fakeConnectWise(routingRoutes());
    const out = json(await call("cw_list_email_connectors", { boardId: 5 })) as { connectors: unknown[] };
    expect(out.connectors).toEqual([
      {
        id: 3,
        emailServerType: "Office365",
        office365EmailSetup: { id: 1, name: "desk@example.test" },
        serviceBoard: { id: 5, name: "Service Desk" },
        defaultMember: nathan,
      },
    ]);
    expect(cw.calls[0].query.conditions).toBe("serviceBoard/id=5");
  });

  it("cw_get_email_connector returns each parsing style with its mail-handling rules", async () => {
    const cw = fakeConnectWise({
      "/system/emailConnectors/3": { id: 3, defaultMember: nathan },
      "/system/emailConnectors/3/parsingStyles": [{ id: 6, parseRule: "Subject", priority: 1 }],
      "/system/emailConnectors/3/parsingStyles/6/parsingRules": [
        { id: 7, searchTerm: "URGENT", priority: 1, serviceBoard: { id: 5, name: "Service Desk" } },
      ],
    });
    const out = json(await call("cw_get_email_connector", { id: 3 })) as {
      parsingStyles: Array<{ parsingRules: unknown[] }>;
    };
    expect(out).toMatchObject({ id: 3, defaultMember: nathan });
    expect(out.parsingStyles[0]).toMatchObject({ id: 6, parseRule: "Subject" });
    expect(out.parsingStyles[0].parsingRules).toEqual([
      { id: 7, searchTerm: "URGENT", priority: 1, serviceBoard: { id: 5, name: "Service Desk" } },
    ]);
    expect(cw.calls.map((entry) => entry.path)).toEqual([
      "/system/emailConnectors/3",
      "/system/emailConnectors/3/parsingStyles",
      "/system/emailConnectors/3/parsingStyles/6/parsingRules",
    ]);
  });

  it("cw_list_slas and cw_get_sla read the SLA and its priorities", async () => {
    const cw = fakeConnectWise({
      "/service/slas": [{ id: 1, name: "Standard", basedOn: "MyCalendar", defaultFlag: true, respondHours: 1, hiImpactHiUrgency: { id: 1, name: "P1" } }],
      "/service/slas/1": { id: 1, name: "Standard", hiImpactHiUrgency: { id: 1, name: "P1" } },
      "/service/slas/1/priorities": [{ id: 4, priority: { id: 1, name: "P1" }, respondHours: 0.5 }],
    });
    const list = json(await call("cw_list_slas", {})) as { slas: unknown[] };
    expect(list.slas).toEqual([{ id: 1, name: "Standard", basedOn: "MyCalendar", defaultFlag: true, respondHours: 1 }]);
    const sla = json(await call("cw_get_sla", { id: 1 }));
    expect(sla).toMatchObject({ id: 1, hiImpactHiUrgency: { id: 1, name: "P1" } });
    expect(sla.priorities).toEqual([{ id: 4, priority: { id: 1, name: "P1" }, respondHours: 0.5 }]);
    expect(cw.calls.map((entry) => entry.path)).toEqual(["/service/slas", "/service/slas/1", "/service/slas/1/priorities"]);
  });
});

describe("cw_trace_ticket_routing", () => {
  it("shows the owner the ticket arrived with and the setup that explains it", async () => {
    const cw = fakeConnectWise(routingRoutes());
    const result = await call("cw_trace_ticket_routing", { ticketId: 700 });
    expect(result.isError).not.toBe(true);
    const out = json(result) as {
      ticket: Record<string, unknown>;
      candidates: Array<Record<string, unknown>>;
      workflowRules: Array<{ events: Array<Record<string, unknown>> }>;
    };

    expect(out.ticket).toMatchObject({
      id: 700,
      board: { id: 5, name: "Service Desk" },
      team: { id: 9, name: "Level 1" },
      owner: priya,
      source: { id: 2, name: "Email Connector" },
      _info: { enteredBy: "PShah", dateEntered: "2026-10-01T01:00:00Z" },
    });
    expect(out.ticket).not.toHaveProperty("initialDescription");

    // The current owner is Priya. The trace explains Nathan, the owner before the first change.
    expect(out).toMatchObject({
      arrivedOwner: { id: 12, identifier: "NColyer", name: "Nathan Colyer-Long" },
      ownerChanges: [
        { from: "Nathan Colyer-Long", to: "Priya Shah", enteredBy: "Stephan Jenner", enteredDate: "2026-10-01T03:00:00Z" },
      ],
      autoAssigned: ["Nathan Colyer-Long", "Priya Shah"],
      auditEntryCount: 7,
      unread: [],
    });

    expect(out.candidates.map((candidate) => [candidate.source, candidate.evidence])).toEqual([
      ["board-auto-assign", "audit"],
      ["workflow-action", "audit"],
      ["email-connector-default-member", "setup"],
      ["team-leader", "setup"],
    ]);
    expect(out.candidates[0]).toMatchObject({
      position: 1,
      autoAssigned: ["Nathan Colyer-Long", "Priya Shah"],
      boardFlags: { autoAssignNewTicketsFlag: true, autoAssignTicketOwnerFlag: true },
      resources: [{ member: null, notifyWho: { id: 7, identifier: "T", name: "All Team Members" } }],
    });
    expect(String(out.candidates[0].detail)).toMatch(/autoAssignTicketOwnerFlag is on/);
    expect(out.candidates[1]).toMatchObject({
      rule: { id: 21, name: "Assign new tickets" },
      event: { id: 77 },
      action: { id: 88, updateOwnerFlag: true },
    });

    expect(out).toMatchObject({
      board: { id: 5, autoAssignNewTicketsFlag: true, autoAssignTicketOwnerFlag: true, dispatchMember: priya },
      ticketTeam: { id: 9, teamLeader: nathan, roundRobinFlag: true },
      defaultTeam: { id: 9, name: "Level 1", sameAsTicketTeam: true },
      emailConnectors: [{ id: 3, defaultMember: nathan }],
    });

    const event = out.workflowRules[0].events[0];
    expect(event).toMatchObject({
      id: 77,
      name: "On create",
      conditionMatch: {
        result: "match",
        parsed: true,
        terms: [
          { triggerId: 19, text: "Priority is Priority 2 - High", result: "true" },
          { triggerId: 33, text: "Ticket is in New status", result: "true" },
        ],
      },
      ranOnTicket: { count: 2, first: "2026-10-01T01:30:00Z", last: "2026-10-01T02:00:00Z" },
      actions: [
        { id: 88, notifyType: { id: 4, name: "Assign Member" }, specificMemberTo: nathan, updateOwnerFlag: true },
        { id: 89, notifyType: { id: 5, name: "Send Email" }, specificMemberTo: priya },
      ],
    });
    // The trace gives the condition in words, not the raw text, and no action body.
    expect(event).not.toHaveProperty("eventCondition");
    expect(JSON.stringify(event)).not.toContain("<html>");

    const audit = cw.calls.find((entry) => entry.path === "/system/audittrail")!;
    expect(audit.query).toMatchObject({ type: "Ticket", id: "700" });
    const rules = cw.calls.find((entry) => entry.path === "/system/workflows")!;
    expect(rules.query.conditions).toBe("board/id=5 and activateFlag=true");
  });

  it("takes the current owner as the arrived owner when the audit trail holds no owner change", async () => {
    const routes = routingRoutes();
    routes["/system/audittrail"] = (routes["/system/audittrail"] as Array<{ text: string }>).filter(
      (entry) => !entry.text.startsWith("Owner has been updated"),
    );
    fakeConnectWise(routes);
    const out = json(await call("cw_trace_ticket_routing", { ticketId: 700 })) as {
      arrivedOwner: Record<string, unknown>;
      ownerChanges: unknown[];
      candidates: Array<{ source: string }>;
    };
    expect(out.ownerChanges).toEqual([]);
    expect(out.arrivedOwner).toMatchObject({ id: 31, name: "Priya Shah" });
    expect(String(out.arrivedOwner.basis)).toMatch(/no owner change/);
    // Priya was auto-assigned second, is named by a workflow action, holds the dispatch role and entered the ticket.
    expect(out.candidates.map((candidate) => candidate.source)).toEqual([
      "board-auto-assign",
      "workflow-action",
      "board-role-member",
      "entered-by-owner",
    ]);
  });

  it("names a section it could not read and guesses nothing for it", async () => {
    fakeConnectWise(routingRoutes({ "/system/workflows": 403, "/system/audittrail": 403 }));
    const result = await call("cw_trace_ticket_routing", { ticketId: 700 });
    const out = json(result) as {
      unread: Array<{ section: string; error: string }>;
      candidates: Array<{ source: string }>;
      workflowRules: unknown[];
      ownerChanges: unknown[];
      autoAssigned: unknown[];
      arrivedOwner: { id: number };
    };
    expect(out.unread.map((entry) => entry.section)).toEqual(["auditTrail", "workflowRules"]);
    for (const entry of out.unread) {
      expect(entry.error).toMatch(/returned 403 \(reference /);
      expect(entry.error).not.toContain("SECRET");
    }
    expect(out.workflowRules).toEqual([]);
    expect(out.ownerChanges).toEqual([]);
    expect(out.autoAssigned).toEqual([]);
    // With no audit trail the current owner is all the trace has, and no audit-backed candidate is made up.
    expect(out.arrivedOwner.id).toBe(31);
    expect(out.candidates.map((candidate) => candidate.source)).toEqual(["board-role-member", "entered-by-owner"]);
  });

  it("returns no candidate for a ticket that never had an owner", async () => {
    const routes = routingRoutes({ "/system/audittrail": [] });
    (routes["/service/tickets/700"] as Record<string, unknown>).owner = null;
    fakeConnectWise(routes);
    const out = json(await call("cw_trace_ticket_routing", { ticketId: 700 })) as {
      arrivedOwner: unknown;
      candidates: unknown[];
    };
    expect(out.arrivedOwner).toBeNull();
    expect(out.candidates).toEqual([]);
  });

  it("fails as a tool error when the ticket itself cannot be read", async () => {
    fakeConnectWise({});
    const result = await call("cw_trace_ticket_routing", { ticketId: 700 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/returned 404/);
  });
});

describe("evaluateEventCondition", () => {
  const term = (id: number, triggerId: number, value: string, description: string, template: string) =>
    JSON.stringify({ id, triggerId, value: { value, description }, description: template });
  const statusNew = term(1, 33, "40", "New", "Ticket is in {value} status");
  const statusTriage = term(2, 33, "41", "Triage", "Ticket is in {value} status");
  const priorityHigh = term(3, 19, "15", "Priority 2 - High", "Priority is {value}");
  const priorityCritical = term(4, 19, "6", "Priority 1 - Critical", "Priority is {value}");
  const olderThanSixMinutes = term(5, 239, "0.1", "0.1", "Ticket Actual Age is more than {value} hours");
  const youngerThanOneHour = term(6, 238, "1", "1", "Ticket Actual Age is less than {value} hours");
  const slaChanged = term(7, 93, "24", "24", "Ticket SLA status last changed more than {value} hours ago");

  const ticket = {
    id: 1,
    status: { id: 40, name: "New" },
    priority: { id: 15, name: "Priority 2 - High" },
    closedFlag: false,
    _info: { dateEntered: "2026-10-01T00:00:00Z" },
  };
  const twoHoursOn = new Date("2026-10-01T02:00:00Z");

  it("matches the live form: bracketed groups joined by and and or", () => {
    const condition = `(${priorityCritical} or ${priorityHigh}) and (${statusNew} or ${statusTriage}) and ${olderThanSixMinutes}`;
    const out = evaluateEventCondition(condition, ticket, twoHoursOn);
    expect(out).toMatchObject({ result: "match", parsed: true });
    expect(out.terms.map((entry) => [entry.text, entry.result])).toEqual([
      ["Priority is Priority 1 - Critical", "false"],
      ["Priority is Priority 2 - High", "true"],
      ["Ticket is in New status", "true"],
      ["Ticket is in Triage status", "false"],
      ["Ticket Actual Age is more than 0.1 hours", "true"],
    ]);
  });

  it("reports no match when one term of an and is false", () => {
    const out = evaluateEventCondition(`${statusTriage} and ${priorityHigh}`, ticket, twoHoursOn);
    expect(out.result).toBe("no-match");
  });

  it("reports no match on age when the ticket is younger than the term asks", () => {
    const fiveMinutesOn = new Date("2026-10-01T00:05:00Z");
    expect(evaluateEventCondition(olderThanSixMinutes, ticket, fiveMinutesOn).result).toBe("no-match");
    expect(evaluateEventCondition(youngerThanOneHour, ticket, fiveMinutesOn).result).toBe("match");
    expect(evaluateEventCondition(youngerThanOneHour, ticket, twoHoursOn).result).toBe("no-match");
  });

  it("is unknown when a trigger it does not evaluate decides the answer", () => {
    const out = evaluateEventCondition(`${statusNew} and ${slaChanged}`, ticket, twoHoursOn);
    expect(out.result).toBe("unknown");
    expect(out.terms[1]).toMatchObject({ triggerId: 93, result: "unknown" });
    expect(out.terms[1].reason).toMatch(/not one the trace evaluates/);
  });

  it("lets a known term settle the answer past an unknown one", () => {
    expect(evaluateEventCondition(`${statusTriage} and ${slaChanged}`, ticket, twoHoursOn).result).toBe("no-match");
    expect(evaluateEventCondition(`${statusNew} or ${slaChanged}`, ticket, twoHoursOn).result).toBe("match");
    expect(evaluateEventCondition(`${statusTriage} or ${slaChanged}`, ticket, twoHoursOn).result).toBe("unknown");
  });

  it("gives and a tighter hold than or when there are no brackets", () => {
    // New or (Triage and Critical): true. (New or Triage) and Critical would be false.
    const out = evaluateEventCondition(`${statusNew} or ${statusTriage} and ${priorityCritical}`, ticket, twoHoursOn);
    expect(out.result).toBe("match");
  });

  it("does not judge the age of a closed ticket", () => {
    const out = evaluateEventCondition(olderThanSixMinutes, { ...ticket, closedFlag: true }, twoHoursOn);
    expect(out.result).toBe("unknown");
    expect(out.terms[0].reason).toMatch(/closed/);
  });

  it("reads a brace and a quote inside a term's text", () => {
    const tricky = term(8, 33, "40", 'New "{urgent}"', "Ticket is in {value} status");
    const out = evaluateEventCondition(tricky, ticket, twoHoursOn);
    expect(out).toMatchObject({ result: "match", parsed: true });
    expect(out.terms[0].text).toBe('Ticket is in New "{urgent}" status');
  });

  it("evaluates nothing for text that is not in the condition form", () => {
    for (const bad of ["Board = 5", `${statusNew} xor ${statusTriage}`, `(${statusNew}`, `${statusNew} and`, "", null, 7]) {
      expect(evaluateEventCondition(bad, ticket, twoHoursOn)).toEqual({ result: "unknown", parsed: false, terms: [] });
    }
  });
});

describe("readAuditFacts and findArrivedOwner", () => {
  // Newest first, as ConnectWise returns it. The literal backslash-n is how the API sends the line break.
  const audit = [
    { text: 'Owner has been updated from "Andy V" to "Jason C".', enteredDate: "2026-10-07T07:41:00Z", enteredBy: "Stephan Jenner", auditSubType: "Owner" },
    { text: 'Notes have been added.\\r\\n"Owner changed from Nathan to Andy"', enteredDate: "2026-10-07T04:12:20Z", enteredBy: "Stephan Jenner" },
    { text: 'Owner has been updated from "Nathan C" to "Andy V".', enteredDate: "2026-10-07T04:12:17Z", enteredBy: "Stephan Jenner", auditSubType: "Owner" },
    { text: 'Workflow "Notify" ran on this ticket. EventID: "582".', enteredDate: "2026-10-07T03:02:23Z", enteredBy: "CW Service" },
    { text: 'Workflow "Notify" ran on this ticket. EventID: "582".', enteredDate: "2026-10-07T02:32:22Z", enteredBy: "CW Service" },
    { text: "New Ticket #1 has been created.", enteredDate: "2026-10-07T02:23:01Z", enteredBy: "Email Connector" },
    { text: "New schedule record added by service board automatic assignment.\\n Member: Yahya E", enteredDate: "2026-10-07T02:23:01Z", enteredBy: "autoassign" },
    { text: "New schedule record added by service board automatic assignment.\\n Member: Andy V", enteredDate: "2026-10-07T02:23:01Z", enteredBy: "autoassign" },
    { text: "New schedule record added by service board automatic assignment.\\n Member: Nathan C", enteredDate: "2026-10-07T02:23:01Z", enteredBy: "autoassign" },
  ];

  it("reads owner changes oldest first and ignores a note that only talks about the owner", () => {
    expect(readAuditFacts(audit).ownerChanges).toEqual([
      { from: "Nathan C", to: "Andy V", enteredDate: "2026-10-07T04:12:17Z", enteredBy: "Stephan Jenner" },
      { from: "Andy V", to: "Jason C", enteredDate: "2026-10-07T07:41:00Z", enteredBy: "Stephan Jenner" },
    ]);
  });

  it("reads the automatic assignment in the order it was written, within one second", () => {
    expect(readAuditFacts(audit).autoAssigned).toEqual(["Nathan C", "Andy V", "Yahya E"]);
  });

  it("counts the runs of each workflow event", () => {
    expect(readAuditFacts(audit).workflowRuns).toEqual([
      { rule: "Notify", eventId: 582, count: 2, first: "2026-10-07T02:32:22Z", last: "2026-10-07T03:02:23Z" },
    ]);
  });

  it("returns empty facts for an empty or unreadable audit trail", () => {
    expect(readAuditFacts([])).toEqual({ ownerChanges: [], autoAssigned: [], workflowRuns: [] });
    expect(readAuditFacts([{ text: null }, {}])).toEqual({ ownerChanges: [], autoAssigned: [], workflowRuns: [] });
  });

  const teams = [{ id: 9, teamLeader: { id: 12, identifier: "nc", name: "Nathan C" }, members: [{ id: 14, identifier: "av", name: "Andy V" }] }];
  const jason = { id: 20, identifier: "jc", name: "Jason C" };

  it("finds the arrived owner's id from the teams when the audit trail gives only a name", () => {
    expect(findArrivedOwner({ owner: jason }, readAuditFacts(audit), teams)).toMatchObject({
      id: 12,
      identifier: "nc",
      name: "Nathan C",
    });
  });

  it("keeps the name with no id when no team holds the member", () => {
    expect(findArrivedOwner({ owner: jason }, readAuditFacts(audit), [])).toMatchObject({ id: null, name: "Nathan C" });
  });

  it("returns null when the first owner change was from no owner", () => {
    const facts = readAuditFacts([{ text: 'Owner has been updated from "" to "Jason C".', enteredDate: "2026-10-07T07:41:00Z" }]);
    expect(findArrivedOwner({ owner: jason }, facts, teams)).toBeNull();
  });
});

describe("findOwnerCandidates", () => {
  const noFacts = { ownerChanges: [], autoAssigned: [], workflowRuns: [] };
  function evidence(over: Partial<RoutingEvidence> = {}): RoutingEvidence {
    return {
      ticket: { id: 1, board: { id: 5 }, team: { id: 9 }, owner: nathan, _info: { enteredBy: "PShah" } },
      board: { id: 5, autoAssignTicketOwnerFlag: true },
      autoAssignResources: [],
      teams: [],
      connectors: [],
      workflowRules: [],
      facts: noFacts,
      ...over,
    };
  }

  it("returns nothing when no setup names the owner, and nothing for no owner", () => {
    expect(findOwnerCandidates(evidence(), nathan)).toEqual([]);
    expect(findOwnerCandidates(evidence({ teams: [{ id: 9, teamLeader: nathan }] }), null)).toEqual([]);
  });

  it("ignores a workflow action, connector, team and resource that name another member", () => {
    const found = findOwnerCandidates(
      evidence({
        workflowRules: [{ id: 1, name: "R", events: [{ id: 2, name: "E", actions: [{ id: 3, specificMemberTo: priya }] }] }],
        connectors: [{ id: 3, serviceBoard: { id: 5 }, defaultMember: priya }],
        teams: [{ id: 9, teamLeader: priya, defaultFlag: true }],
        autoAssignResources: [{ id: 1, member: priya }],
        facts: { ...noFacts, autoAssigned: ["Priya Shah"] },
      }),
      nathan,
    );
    expect(found).toEqual([]);
  });

  it("says the automatic assignment made a resource, not the owner, when the owner flag is off", () => {
    const found = findOwnerCandidates(
      evidence({ board: { id: 5, autoAssignTicketOwnerFlag: false }, facts: { ...noFacts, autoAssigned: ["Priya Shah", "Nathan Colyer-Long"] } }),
      nathan,
    );
    expect(found).toMatchObject([{ source: "board-auto-assign", evidence: "audit", position: 2 }]);
    expect(found[0].detail).toMatch(/not on, so this assignment made the member a resource/);
  });

  it("marks a workflow action as setup only when the audit trail does not show the event ran", () => {
    const workflowRules = [{ id: 1, name: "R", events: [{ id: 2, name: "E", actions: [{ id: 3, specificMemberTo: nathan }] }] }];
    expect(findOwnerCandidates(evidence({ workflowRules }), nathan)).toMatchObject([
      { source: "workflow-action", evidence: "setup" },
    ]);
    const ran = { ...noFacts, workflowRuns: [{ rule: "R", eventId: 2, count: 1, first: null, last: null }] };
    expect(findOwnerCandidates(evidence({ workflowRules, facts: ran }), nathan)).toMatchObject([
      { source: "workflow-action", evidence: "audit" },
    ]);
  });

  it("names a specific auto-assign resource when the audit trail holds no assignment", () => {
    const found = findOwnerCandidates(evidence({ autoAssignResources: [{ id: 1, member: nathan }] }), nathan);
    expect(found).toMatchObject([{ source: "board-auto-assign-resource", evidence: "setup" }]);
  });

  it("ignores a connector with the owner as default member that files to another board", () => {
    const found = findOwnerCandidates(
      evidence({ connectors: [{ id: 3, serviceBoard: { id: 6 }, defaultMember: nathan }] }),
      nathan,
    );
    expect(found).toEqual([]);
  });

  it("ignores a team the owner leads that is neither the ticket's team nor the default", () => {
    expect(findOwnerCandidates(evidence({ teams: [{ id: 10, teamLeader: nathan, defaultFlag: false }] }), nathan)).toEqual([]);
  });

  it("names a board role the owner holds", () => {
    const found = findOwnerCandidates(
      evidence({ board: { id: 5, serviceManagerMember: nathan, dispatchMember: priya } }),
      nathan,
    );
    expect(found).toMatchObject([{ source: "board-role-member", roles: ["serviceManagerMember"] }]);
  });

  it("matches a member by name when the audit trail gave no id", () => {
    const byName = { id: null, name: "nathan colyer-long" };
    const found = findOwnerCandidates(evidence({ teams: [{ id: 9, teamLeader: nathan }] }), byName);
    expect(found).toMatchObject([{ source: "team-leader" }]);
  });

  it("names the owner as the member who entered the ticket, ignoring case", () => {
    const found = findOwnerCandidates(
      evidence({ ticket: { id: 1, board: { id: 5 }, owner: nathan, _info: { enteredBy: "ncolyer" } } }),
      nathan,
    );
    expect(found).toMatchObject([{ source: "entered-by-owner", enteredBy: "ncolyer" }]);
  });
});

describe("setup shapes", () => {
  it("toRef reduces a reference and returns null for a missing one", () => {
    expect(toRef({ id: 1, name: "A", _info: { href: "x" } })).toEqual({ id: 1, name: "A" });
    expect(toRef({ id: 2, identifier: "ab", name: "A B", extra: true })).toEqual({ id: 2, identifier: "ab", name: "A B" });
    expect(toRef(null)).toBeNull();
    expect(toRef(undefined)).toBeNull();
  });

  it("toBoardAssignment keeps the assignment fields and adds none the board does not hold", () => {
    expect(toBoardAssignment({ id: 5, name: "B", autoAssignNewTicketsFlag: true, oncallMember: priya, billTime: "Billable" })).toEqual({
      id: 5,
      name: "B",
      autoAssignNewTicketsFlag: true,
      oncallMember: priya,
    });
  });

  it("toLeanBoardStatus reads a missing closed or inactive flag as false", () => {
    expect(toLeanBoardStatus({ id: 1, name: "New" })).toEqual({ id: 1, name: "New", closedStatus: false, inactive: false });
  });
});

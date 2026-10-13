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
  findOwnerCandidates,
  ownerAuditEntries,
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

/** The setup behind one ticket: board 5, team 9 led by Nathan, one connector, one rule. */
function routingRoutes(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "/service/tickets/700": {
      id: 700,
      summary: "Printer offline",
      board: { id: 5, name: "Service Desk" },
      team: { id: 9, name: "Level 1" },
      owner: nathan,
      status: { id: 40, name: "New" },
      company: { id: 250, identifier: "FLHQ", name: "Future Logic" },
      source: { id: 2, name: "Email Connector" },
      initialDescription: "A long body the trace must not return",
      _info: { dateEntered: "2026-10-01T01:00:00Z", enteredBy: "EmailConnector", lastUpdated: "2026-10-01T01:05:00Z" },
    },
    "/system/audittrail": [
      { text: "Ticket has been created", enteredBy: "EmailConnector", enteredDate: "2026-10-01T01:00:00Z", auditType: "Record" },
      { text: "Owner has been assigned to NColyer", enteredBy: "Workflow", enteredDate: "2026-10-01T01:00:05Z", auditType: "Resource" },
      { text: "Status has been updated from New to Assigned", enteredBy: "NColyer", enteredDate: "2026-10-01T02:00:00Z", auditType: "Tickets" },
    ],
    "/service/boards/5": {
      id: 5,
      name: "Service Desk",
      inactiveFlag: false,
      autoAssignNewTicketsFlag: true,
      autoAssignTicketOwnerFlag: false,
      dispatchMember: priya,
      notifyEmailFrom: "desk@example.test",
    },
    "/service/boards/5/autoAssignResources": [{ id: 1, member: nathan, notifyWho: { id: 3, name: "Owner" } }],
    "/service/boards/5/teams": [
      { id: 9, name: "Level 1", boardId: 5, defaultFlag: true, teamLeader: nathan, members: [12, 31] },
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
      { id: 77, name: "On create", eventCondition: "raw condition text", frequencyUnit: "Minutes" },
    ],
    "/system/workflows/21/events/77/actions": [
      { id: 88, notifyType: { id: 4, name: "Assign Member" }, specificMemberTo: nathan, updateOwnerFlag: true },
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
  });
});

describe("boards, teams, statuses and types", () => {
  it("cw_get_board returns the board record with its auto-assign resources", async () => {
    const cw = fakeConnectWise(routingRoutes());
    const out = json(await call("cw_get_board", { id: 5 }));
    expect(out.board).toMatchObject({ id: 5, autoAssignNewTicketsFlag: true, dispatchMember: priya });
    expect(out.autoAssignResources).toEqual([{ id: 1, member: nathan, notifyWho: { id: 3, name: "Owner" } }]);
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
    expect(out.events[0].eventCondition).toBe("raw condition text");
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
  it("shows the board, team, owner, the owner audit lines and every setup that names the owner", async () => {
    const cw = fakeConnectWise(routingRoutes());
    const result = await call("cw_trace_ticket_routing", { ticketId: 700 });
    expect(result.isError).not.toBe(true);
    const out = json(result) as {
      ticket: Record<string, unknown>;
      ownerAudit: Array<Record<string, unknown>>;
      candidates: Array<Record<string, unknown>>;
      workflowRules: Array<Record<string, unknown>>;
      unread: unknown[];
    };

    expect(out.ticket).toMatchObject({
      id: 700,
      board: { id: 5, name: "Service Desk" },
      team: { id: 9, name: "Level 1" },
      owner: nathan,
      source: { id: 2, name: "Email Connector" },
      _info: { enteredBy: "EmailConnector", dateEntered: "2026-10-01T01:00:00Z" },
    });
    expect(out.ticket).not.toHaveProperty("initialDescription");

    expect(out.ownerAudit).toEqual([
      { text: "Owner has been assigned to NColyer", enteredBy: "Workflow", enteredDate: "2026-10-01T01:00:05Z", auditType: "Resource" },
    ]);
    expect(out).toMatchObject({ auditEntryCount: 3, conditionsEvaluated: false, unread: [] });

    expect(out.candidates.map((candidate) => candidate.source)).toEqual([
      "workflow-action",
      "email-connector-default-member",
      "board-auto-assign-resource",
      "team-leader",
    ]);
    expect(out.candidates[0]).toMatchObject({
      rule: { id: 21, name: "Assign new tickets", activateFlag: true },
      event: { id: 77, eventCondition: "raw condition text" },
      action: { id: 88, updateOwnerFlag: true },
    });
    expect(out).toMatchObject({
      board: { id: 5, autoAssignNewTicketsFlag: true, autoAssignTicketOwnerFlag: false, dispatchMember: priya },
      ticketTeam: { id: 9, teamLeader: nathan },
      defaultTeam: { id: 9, defaultFlag: true },
      emailConnectors: [{ id: 3, defaultMember: nathan }],
    });
    expect(out.workflowRules[0]).toMatchObject({ id: 21, events: [{ id: 77, actions: [{ id: 88 }, { id: 89 }] }] });

    const audit = cw.calls.find((entry) => entry.path === "/system/audittrail")!;
    expect(audit.query).toMatchObject({ type: "Ticket", id: "700" });
    const rules = cw.calls.find((entry) => entry.path === "/system/workflows")!;
    expect(rules.query.conditions).toBe("board/id=5 and activateFlag=true");
  });

  it("names a section it could not read and guesses nothing for it", async () => {
    fakeConnectWise(routingRoutes({ "/system/workflows": 403, "/system/audittrail": 403 }));
    const result = await call("cw_trace_ticket_routing", { ticketId: 700 });
    const out = json(result) as {
      unread: Array<{ section: string; error: string }>;
      candidates: Array<{ source: string }>;
      workflowRules: unknown[];
      ownerAudit: unknown[];
    };
    expect(out.unread.map((entry) => entry.section)).toEqual(["auditTrail", "workflowRules"]);
    for (const entry of out.unread) {
      expect(entry.error).toMatch(/returned 403 \(reference /);
      expect(entry.error).not.toContain("SECRET");
    }
    expect(out.workflowRules).toEqual([]);
    expect(out.ownerAudit).toEqual([]);
    // The sections that were read still give their candidates, and none is made up for the rest.
    expect(out.candidates.map((candidate) => candidate.source)).toEqual([
      "email-connector-default-member",
      "board-auto-assign-resource",
      "team-leader",
    ]);
  });

  it("returns no candidate for a ticket with no owner", async () => {
    const routes = routingRoutes();
    (routes["/service/tickets/700"] as Record<string, unknown>).owner = null;
    fakeConnectWise(routes);
    const out = json(await call("cw_trace_ticket_routing", { ticketId: 700 })) as {
      ticket: { owner: unknown };
      candidates: unknown[];
    };
    expect(out.ticket.owner).toBeNull();
    expect(out.candidates).toEqual([]);
  });

  it("fails as a tool error when the ticket itself cannot be read", async () => {
    fakeConnectWise({});
    const result = await call("cw_trace_ticket_routing", { ticketId: 700 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/returned 404/);
  });
});

describe("findOwnerCandidates", () => {
  function evidence(over: Partial<RoutingEvidence> = {}): RoutingEvidence {
    return {
      ticket: { id: 1, board: { id: 5 }, team: { id: 9 }, owner: nathan, _info: { enteredBy: "PShah" } },
      board: { id: 5, autoAssignTicketOwnerFlag: true },
      autoAssignResources: [],
      teams: [],
      connectors: [],
      workflowRules: [],
      audit: [],
      ...over,
    };
  }

  it("returns nothing when no setup names the owner", () => {
    expect(findOwnerCandidates(evidence())).toEqual([]);
  });

  it("ignores a workflow action, connector and team that name another member", () => {
    const found = findOwnerCandidates(
      evidence({
        workflowRules: [{ id: 1, name: "R", events: [{ id: 2, name: "E", actions: [{ id: 3, specificMemberTo: priya }] }] }],
        connectors: [{ id: 3, serviceBoard: { id: 5 }, defaultMember: priya }],
        teams: [{ id: 9, teamLeader: priya, defaultFlag: true }],
        autoAssignResources: [{ id: 1, member: priya }],
      }),
    );
    expect(found).toEqual([]);
  });

  it("ignores a connector with the owner as default member that files to another board", () => {
    const found = findOwnerCandidates(
      evidence({ connectors: [{ id: 3, serviceBoard: { id: 6 }, defaultMember: nathan }] }),
    );
    expect(found).toEqual([]);
  });

  it("ignores a team the owner leads that is neither the ticket's team nor the default", () => {
    const found = findOwnerCandidates(evidence({ teams: [{ id: 10, teamLeader: nathan, defaultFlag: false }] }));
    expect(found).toEqual([]);
  });

  it("names a board role the owner holds", () => {
    const found = findOwnerCandidates(evidence({ board: { id: 5, serviceManagerMember: nathan, dispatchMember: priya } }));
    expect(found).toMatchObject([{ source: "board-role-member", roles: ["serviceManagerMember"] }]);
  });

  it("names the owner as the member who entered the ticket, ignoring case", () => {
    const found = findOwnerCandidates(
      evidence({ ticket: { id: 1, board: { id: 5 }, owner: nathan, _info: { enteredBy: "ncolyer" } } }),
    );
    expect(found).toMatchObject([{ source: "entered-by-owner", enteredBy: "ncolyer", autoAssignTicketOwnerFlag: true }]);
  });
});

describe("setup shapes", () => {
  it("ownerAuditEntries keeps only lines that speak about the owner", () => {
    expect(
      ownerAuditEntries([
        { text: "Owner has been updated" },
        { text: "The homeowner called" },
        { text: "Status changed" },
        { text: null },
      ]),
    ).toEqual([{ text: "Owner has been updated" }]);
  });

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

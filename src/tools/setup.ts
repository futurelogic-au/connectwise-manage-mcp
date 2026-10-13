import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient } from "../api-client.js";
import { andConditions, fetchAllPages, mapWithConcurrency } from "./paging.js";

/**
 * Setup read tools (ConnectWise Service and System APIs).
 *
 * These read the configuration that decides where a service ticket lands and
 * who owns it: boards, board teams, statuses, types and subtypes, workflow
 * rules, email connectors and SLAs. Every tool here is read-only. There is
 * deliberately no create, update or delete on a setup table.
 */

const SETUP_READ_ONLY = { readOnlyHint: true };

/** Detail reads for one trace or one rule run at most this many at a time. */
const DETAIL_CONCURRENCY = 4;

type CwRecord = Record<string, unknown>;

function jsonContent(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asRecord(value: unknown): CwRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as CwRecord)
    : null;
}

function idOf(value: unknown): number | null {
  const id = asRecord(value)?.id;
  return typeof id === "number" ? id : null;
}

/** Reduce a ConnectWise reference to id and name, with identifier where it has one. */
export function toRef(value: unknown): { id: number | null; identifier?: string; name: string | null } | null {
  const record = asRecord(value);
  if (!record) return null;
  return {
    id: typeof record.id === "number" ? record.id : null,
    ...(typeof record.identifier === "string" ? { identifier: record.identifier } : {}),
    name: typeof record.name === "string" ? record.name : null,
  };
}

/** Copy the named keys that the record holds, so a lean row never invents a field. */
function pick(record: CwRecord, keys: string[]): CwRecord {
  const out: CwRecord = {};
  for (const key of keys) {
    if (record[key] !== undefined) out[key] = record[key];
  }
  return out;
}

/** Copy the named reference keys, each reduced to id and name. */
function pickRefs(record: CwRecord, keys: string[]): CwRecord {
  const out: CwRecord = {};
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) out[key] = toRef(record[key]);
  }
  return out;
}

const BOARD_ASSIGN_FLAGS = [
  "autoAssignNewTicketsFlag",
  "autoAssignNewECTicketsFlag",
  "autoAssignNewPortalTicketsFlag",
  "autoAssignTicketOwnerFlag",
];
const BOARD_ROLE_MEMBERS = [
  "dispatchMember",
  "serviceManagerMember",
  "dutyManagerMember",
  "oncallMember",
];

/** The part of a board record that decides who a new ticket is given to. */
export function toBoardAssignment(board: CwRecord): CwRecord {
  return {
    id: board.id ?? null,
    name: board.name ?? null,
    ...pick(board, ["inactiveFlag", "projectFlag", ...BOARD_ASSIGN_FLAGS]),
    ...pickRefs(board, ["location", "department", ...BOARD_ROLE_MEMBERS]),
  };
}

/** A board status with the flags a board review reads. */
export function toLeanBoardStatus(status: CwRecord): CwRecord {
  return {
    id: status.id ?? null,
    name: status.name ?? null,
    closedStatus: status.closedStatus === true,
    inactive: status.inactive === true,
    ...pick(status, [
      "escalationStatus",
      "defaultFlag",
      "displayOnBoard",
      "timeEntryNotAllowed",
      "sortOrder",
      "customerPortalFlag",
    ]),
  };
}

function toLeanType(type: CwRecord): CwRecord {
  return {
    id: type.id ?? null,
    name: type.name ?? null,
    inactiveFlag: type.inactiveFlag === true,
    ...pick(type, ["category", "defaultFlag", "requestForChangeFlag"]),
  };
}

function toLeanSubtype(subtype: CwRecord): CwRecord {
  return {
    id: subtype.id ?? null,
    name: subtype.name ?? null,
    inactiveFlag: subtype.inactiveFlag === true,
    ...pick(subtype, ["typeAssociationIds"]),
  };
}

function toLeanWorkflowRule(rule: CwRecord): CwRecord {
  return {
    id: rule.id ?? null,
    name: rule.name ?? null,
    activateFlag: rule.activateFlag === true,
    ...pickRefs(rule, ["tableType", "board", "location", "department"]),
    ...pick(rule, ["batchInterval", "batchFrequencyUnit", "batchSchedule", "batchLastRan"]),
  };
}

const CONNECTOR_REFS = [
  "imapSetup",
  "office365EmailSetup",
  "googleEmailSetup",
  "serviceBoard",
  "defaultMember",
  "defaultCompany",
  "location",
  "department",
  "statusOverride",
  "typeOverride",
  "subTypeOverride",
  "itemOverride",
  "priorityOverride",
  "sourceOverride",
];

function toLeanEmailConnector(connector: CwRecord): CwRecord {
  return {
    id: connector.id ?? null,
    ...pick(connector, ["name", "emailServerType"]),
    ...pickRefs(connector, CONNECTOR_REFS),
    ...pick(connector, [
      "createContactFlag",
      "setEmailToDefaultContactFlag",
      "postRepliesToTicketFlag",
      "discardDuplicatesFlag",
      "addCcFlag",
      "neverRespondFlag",
      "noResponseFlag",
    ]),
  };
}

function toLeanSla(sla: CwRecord): CwRecord {
  return {
    id: sla.id ?? null,
    name: sla.name ?? null,
    ...pick(sla, [
      "basedOn",
      "defaultFlag",
      "applicationOrder",
      "respondHours",
      "respondPercent",
      "planWithin",
      "planWithinPercent",
      "resolutionHours",
      "resolutionPercent",
    ]),
    ...pickRefs(sla, ["customCalendar"]),
  };
}

interface LeanMember {
  id: number;
  identifier: string | null;
  name: string | null;
  inactiveFlag: boolean | null;
}

/**
 * Resolve member ids to identifier and name. A team record holds member ids
 * only, and an id alone does not say who is on the team.
 */
async function resolveMembers(client: CwManageClient, ids: number[]): Promise<Map<number, LeanMember>> {
  const found = new Map<number, LeanMember>();
  const unique = [...new Set(ids)];
  for (let start = 0; start < unique.length; start += 100) {
    const chunk = unique.slice(start, start + 100);
    const members = await fetchAllPages<CwRecord>(client, "/system/members", {
      conditions: `id in (${chunk.join(",")})`,
      fields: "id,identifier,firstName,lastName,inactiveFlag",
    });
    for (const member of members) {
      if (typeof member.id !== "number") continue;
      const name = [member.firstName, member.lastName].filter((part) => typeof part === "string" && part).join(" ");
      found.set(member.id, {
        id: member.id,
        identifier: typeof member.identifier === "string" ? member.identifier : null,
        name: name || null,
        inactiveFlag: typeof member.inactiveFlag === "boolean" ? member.inactiveFlag : null,
      });
    }
  }
  return found;
}

function memberIdsOf(team: CwRecord): number[] {
  return Array.isArray(team.members)
    ? team.members.filter((id): id is number => typeof id === "number")
    : [];
}

/** A board team with its leader and its members named. */
function toTeam(team: CwRecord, members: Map<number, LeanMember>): CwRecord {
  return {
    id: team.id ?? null,
    name: team.name ?? null,
    defaultFlag: team.defaultFlag === true,
    teamLeader: toRef(team.teamLeader),
    members: memberIdsOf(team).map(
      (id) => members.get(id) ?? { id, identifier: null, name: null, inactiveFlag: null },
    ),
    ...pick(team, ["boardId", "locationId", "businessUnitId", "notifyOnTicketDelete"]),
  };
}

async function readTeams(client: CwManageClient, boardId: number): Promise<CwRecord[]> {
  const teams = await fetchAllPages<CwRecord>(client, `/service/boards/${boardId}/teams`);
  const members = await resolveMembers(client, teams.flatMap(memberIdsOf));
  return teams.map((team) => toTeam(team, members));
}

/** A workflow rule with every event and every action under each event. */
async function readWorkflowRuleDetail(client: CwManageClient, ruleId: number): Promise<CwRecord[]> {
  const events = await fetchAllPages<CwRecord>(client, `/system/workflows/${ruleId}/events`);
  return mapWithConcurrency(events, DETAIL_CONCURRENCY, async (event) => ({
    ...event,
    actions:
      typeof event.id === "number"
        ? await fetchAllPages<CwRecord>(client, `/system/workflows/${ruleId}/events/${event.id}/actions`)
        : [],
  }));
}

/** An email connector's parsing styles, each with its mail-handling rules. */
async function readParsingStyles(client: CwManageClient, connectorId: number): Promise<CwRecord[]> {
  const styles = await fetchAllPages<CwRecord>(client, `/system/emailConnectors/${connectorId}/parsingStyles`);
  return mapWithConcurrency(styles, DETAIL_CONCURRENCY, async (style) => ({
    ...style,
    parsingRules:
      typeof style.id === "number"
        ? await fetchAllPages<CwRecord>(
            client,
            `/system/emailConnectors/${connectorId}/parsingStyles/${style.id}/parsingRules`,
          )
        : [],
  }));
}

// ---------------------------------------------------------------------------
// Routing trace
// ---------------------------------------------------------------------------

/** What the trace read for one ticket, before any conclusion is drawn. */
export interface RoutingEvidence {
  ticket: CwRecord;
  board: CwRecord | null;
  autoAssignResources: CwRecord[];
  teams: CwRecord[];
  connectors: CwRecord[];
  workflowRules: CwRecord[];
  audit: CwRecord[];
}

export interface OwnerCandidate {
  source:
    | "workflow-action"
    | "email-connector-default-member"
    | "board-auto-assign-resource"
    | "team-leader"
    | "board-role-member"
    | "entered-by-owner";
  detail: string;
  [key: string]: unknown;
}

/** Audit trail lines that speak about the owner. */
export function ownerAuditEntries(audit: CwRecord[]): CwRecord[] {
  return audit.filter((entry) => typeof entry.text === "string" && /\bowner\b/i.test(entry.text));
}

/**
 * List every piece of setup that names the ticket's owner. A candidate is
 * setup that could have set the owner, not proof that it did: the audit trail
 * says what happened, and the candidates say which setup agrees with it.
 */
export function findOwnerCandidates(evidence: RoutingEvidence): OwnerCandidate[] {
  const owner = asRecord(evidence.ticket.owner);
  const ownerId = idOf(owner);
  if (ownerId === null) return [];
  const boardId = idOf(evidence.ticket.board);
  const candidates: OwnerCandidate[] = [];

  for (const rule of evidence.workflowRules) {
    for (const event of (rule.events as CwRecord[] | undefined) ?? []) {
      for (const action of (event.actions as CwRecord[] | undefined) ?? []) {
        if (idOf(action.specificMemberTo) !== ownerId) continue;
        candidates.push({
          source: "workflow-action",
          detail: `Workflow rule "${String(rule.name)}", event "${String(event.name)}" has an action that names this member.`,
          rule: { id: rule.id ?? null, name: rule.name ?? null, activateFlag: rule.activateFlag === true },
          event: { id: event.id ?? null, name: event.name ?? null, eventCondition: event.eventCondition ?? null },
          action: {
            id: action.id ?? null,
            notifyType: toRef(action.notifyType),
            updateOwnerFlag: action.updateOwnerFlag ?? null,
          },
        });
      }
    }
  }

  for (const connector of evidence.connectors) {
    if (idOf(connector.defaultMember) !== ownerId) continue;
    if (boardId !== null && idOf(connector.serviceBoard) !== boardId) continue;
    candidates.push({
      source: "email-connector-default-member",
      detail: "An email connector that files to this board has this member as its default member.",
      connector: toLeanEmailConnector(connector),
    });
  }

  if (evidence.autoAssignResources.some((resource) => idOf(resource.member) === ownerId)) {
    candidates.push({
      source: "board-auto-assign-resource",
      detail: "This member is an auto-assign resource on the board.",
      boardFlags: evidence.board ? pick(evidence.board, BOARD_ASSIGN_FLAGS) : {},
    });
  }

  const teamId = idOf(evidence.ticket.team);
  for (const team of evidence.teams) {
    if (idOf(team.teamLeader) !== ownerId) continue;
    if (team.id !== teamId && team.defaultFlag !== true) continue;
    candidates.push({
      source: "team-leader",
      detail:
        team.id === teamId
          ? "This member leads the ticket's team."
          : "This member leads the board's default team.",
      team: { id: team.id ?? null, name: team.name ?? null, defaultFlag: team.defaultFlag === true },
      autoAssignTicketOwnerFlag: evidence.board?.autoAssignTicketOwnerFlag ?? null,
    });
  }

  if (evidence.board) {
    const roles = BOARD_ROLE_MEMBERS.filter((role) => idOf(evidence.board?.[role]) === ownerId);
    if (roles.length > 0) {
      candidates.push({
        source: "board-role-member",
        detail: `This member holds a board role: ${roles.join(", ")}.`,
        roles,
      });
    }
  }

  const enteredBy = asRecord(evidence.ticket._info)?.enteredBy;
  if (typeof enteredBy === "string" && typeof owner?.identifier === "string") {
    if (enteredBy.toLowerCase() === owner.identifier.toLowerCase()) {
      candidates.push({
        source: "entered-by-owner",
        detail: "The owner is the member who entered the ticket.",
        enteredBy,
        autoAssignTicketOwnerFlag: evidence.board?.autoAssignTicketOwnerFlag ?? null,
      });
    }
  }

  return candidates;
}

const TRACE_TICKET_REFS = [
  "board",
  "team",
  "owner",
  "status",
  "company",
  "source",
  "type",
  "subType",
  "item",
  "priority",
  "sla",
];

function toTraceTicket(ticket: CwRecord): CwRecord {
  const info = asRecord(ticket._info) ?? {};
  return {
    id: ticket.id ?? null,
    summary: ticket.summary ?? null,
    ...Object.fromEntries(TRACE_TICKET_REFS.map((key) => [key, toRef(ticket[key])])),
    ...pick(ticket, ["recordType", "resources", "parentTicketId"]),
    _info: pick(info, ["dateEntered", "enteredBy", "lastUpdated", "updatedBy"]),
  };
}

/**
 * Register the setup read tools on the MCP server.
 *
 * @param server MCP server to register tools on.
 * @param client ConnectWise Manage client used by the tools.
 */
export function registerSetupTools(server: McpServer, client: CwManageClient) {
  server.tool(
    "cw_get_board",
    "Get one service board with its setup: the full board record (auto-assign flags, dispatch, service manager, duty manager and on-call members, email connector reopen rules, billing and notification settings) and the board's auto-assign resources. Read-only.",
    { id: z.number().int().positive().describe("Service board ID") },
    SETUP_READ_ONLY,
    async ({ id }) => {
      const board = await client.get<CwRecord>(`/service/boards/${id}`);
      const autoAssignResources = await fetchAllPages<CwRecord>(
        client,
        `/service/boards/${id}/autoAssignResources`,
      );
      return jsonContent({ board, autoAssignResources });
    },
  );

  server.tool(
    "cw_list_board_teams",
    "List every team on a service board. Each team carries its defaultFlag, its team leader and its members, with each member id resolved to identifier and name. Reads all pages. Read-only.",
    { boardId: z.number().int().positive().describe("Service board ID") },
    SETUP_READ_ONLY,
    async ({ boardId }) => {
      const teams = await readTeams(client, boardId);
      return jsonContent({ boardId, count: teams.length, teams });
    },
  );

  server.tool(
    "cw_get_board_team",
    "Get one team on a service board: the full team record, plus its team leader and its members resolved to identifier and name. Read-only.",
    {
      boardId: z.number().int().positive().describe("Service board ID"),
      teamId: z.number().int().positive().describe("Board team ID"),
    },
    SETUP_READ_ONLY,
    async ({ boardId, teamId }) => {
      const team = await client.get<CwRecord>(`/service/boards/${boardId}/teams/${teamId}`);
      const members = await resolveMembers(client, memberIdsOf(team));
      return jsonContent({ ...team, ...toTeam(team, members) });
    },
  );

  server.tool(
    "cw_list_board_statuses",
    "List every status on a service board with the flags a board review needs: closedStatus, inactive, escalationStatus, defaultFlag, displayOnBoard, timeEntryNotAllowed and sortOrder. Reads all pages, in sort order. Use cw_list_statuses for the full records one page at a time. Read-only.",
    {
      boardId: z.number().int().positive().describe("Service board ID"),
      includeInactive: z
        .boolean()
        .optional()
        .describe("Include inactive statuses (default: true)"),
    },
    SETUP_READ_ONLY,
    async ({ boardId, includeInactive }) => {
      const records = await fetchAllPages<CwRecord>(client, `/service/boards/${boardId}/statuses`);
      const statuses = records
        .map(toLeanBoardStatus)
        .filter((status) => includeInactive !== false || status.inactive !== true)
        .sort(
          (a, b) =>
            (typeof a.sortOrder === "number" ? a.sortOrder : Number.MAX_SAFE_INTEGER) -
            (typeof b.sortOrder === "number" ? b.sortOrder : Number.MAX_SAFE_INTEGER),
        );
      return jsonContent({ boardId, count: statuses.length, statuses });
    },
  );

  server.tool(
    "cw_get_board_status",
    "Get one status on a service board, as the full record: closed, inactive and escalation flags, the email template it sends and its customer portal settings. Read-only.",
    {
      boardId: z.number().int().positive().describe("Service board ID"),
      statusId: z.number().int().positive().describe("Board status ID"),
    },
    SETUP_READ_ONLY,
    async ({ boardId, statusId }) =>
      jsonContent(await client.get(`/service/boards/${boardId}/statuses/${statusId}`)),
  );

  server.tool(
    "cw_list_board_types",
    "List every ticket type and subtype on a service board. Each type carries inactiveFlag, category and defaultFlag. Each subtype carries inactiveFlag and typeAssociationIds, the ids of the types it can be used with. Reads all pages. Read-only.",
    { boardId: z.number().int().positive().describe("Service board ID") },
    SETUP_READ_ONLY,
    async ({ boardId }) => {
      const types = await fetchAllPages<CwRecord>(client, `/service/boards/${boardId}/types`);
      const subtypes = await fetchAllPages<CwRecord>(client, `/service/boards/${boardId}/subtypes`);
      return jsonContent({
        boardId,
        typeCount: types.length,
        subtypeCount: subtypes.length,
        types: types.map(toLeanType),
        subtypes: subtypes.map(toLeanSubtype),
      });
    },
  );

  server.tool(
    "cw_get_board_type",
    "Get one ticket type on a service board, as the full record. Read-only.",
    {
      boardId: z.number().int().positive().describe("Service board ID"),
      typeId: z.number().int().positive().describe("Board type ID"),
    },
    SETUP_READ_ONLY,
    async ({ boardId, typeId }) =>
      jsonContent(await client.get(`/service/boards/${boardId}/types/${typeId}`)),
  );

  server.tool(
    "cw_get_board_subtype",
    "Get one ticket subtype on a service board, as the full record. Read-only.",
    {
      boardId: z.number().int().positive().describe("Service board ID"),
      subtypeId: z.number().int().positive().describe("Board subtype ID"),
    },
    SETUP_READ_ONLY,
    async ({ boardId, subtypeId }) =>
      jsonContent(await client.get(`/service/boards/${boardId}/subtypes/${subtypeId}`)),
  );

  server.tool(
    "cw_list_workflow_rules",
    "List workflow rules: id, name, activateFlag, table type, board, location, department and batch schedule. Filter by board or to active rules only. Reads all pages. Use cw_get_workflow_rule for a rule's events and actions. Read-only.",
    {
      boardId: z.number().int().positive().optional().describe("Only rules set on this service board"),
      activeOnly: z.boolean().optional().describe("Only rules that are activated (default: false)"),
      conditions: z.string().optional().describe("ConnectWise conditions query string, added to the filters above"),
    },
    SETUP_READ_ONLY,
    async ({ boardId, activeOnly, conditions }) => {
      const rules = await fetchAllPages<CwRecord>(client, "/system/workflows", {
        conditions: andConditions(
          boardId === undefined ? undefined : `board/id=${boardId}`,
          activeOnly === true ? "activateFlag=true" : undefined,
          conditions,
        ),
      });
      return jsonContent({ count: rules.length, rules: rules.map(toLeanWorkflowRule) });
    },
  );

  server.tool(
    "cw_get_workflow_rule",
    "Get one workflow rule with every event and, under each event, every action. An event carries its eventCondition, exactly as ConnectWise holds it, and how often it runs. An action carries what it does: the notify type, who it notifies or assigns, the status, board, type or template it sets, and updateOwnerFlag. Read-only.",
    { id: z.number().int().positive().describe("Workflow rule ID") },
    SETUP_READ_ONLY,
    async ({ id }) => {
      const rule = await client.get<CwRecord>(`/system/workflows/${id}`);
      const events = await readWorkflowRuleDetail(client, id);
      return jsonContent({ ...rule, events });
    },
  );

  server.tool(
    "cw_list_email_connectors",
    "List email connectors: the mailbox setup, the service board each one files to, its default member and default company, and its status, type, subtype, item, priority and source overrides. Reads all pages. Use cw_get_email_connector for the mail-handling rules. Read-only.",
    {
      boardId: z.number().int().positive().optional().describe("Only connectors that file to this service board"),
    },
    SETUP_READ_ONLY,
    async ({ boardId }) => {
      const connectors = await fetchAllPages<CwRecord>(client, "/system/emailConnectors", {
        conditions: boardId === undefined ? undefined : `serviceBoard/id=${boardId}`,
      });
      return jsonContent({ count: connectors.length, connectors: connectors.map(toLeanEmailConnector) });
    },
  );

  server.tool(
    "cw_get_email_connector",
    "Get one email connector with its mail-handling rules: the full connector record, its parsing styles and, under each style, its parsing rules (the search term and the board, status, type, subtype, item and priority a match sets). Read-only.",
    { id: z.number().int().positive().describe("Email connector ID") },
    SETUP_READ_ONLY,
    async ({ id }) => {
      const connector = await client.get<CwRecord>(`/system/emailConnectors/${id}`);
      const parsingStyles = await readParsingStyles(client, id);
      return jsonContent({ ...connector, parsingStyles });
    },
  );

  server.tool(
    "cw_list_slas",
    "List service level agreements (SLAs): name, basedOn, defaultFlag, application order and the respond, plan and resolution hours and percentages. Reads all pages. Read-only.",
    { conditions: z.string().optional().describe("ConnectWise conditions query string") },
    SETUP_READ_ONLY,
    async ({ conditions }) => {
      const slas = await fetchAllPages<CwRecord>(client, "/service/slas", { conditions });
      return jsonContent({ count: slas.length, slas: slas.map(toLeanSla) });
    },
  );

  server.tool(
    "cw_get_sla",
    "Get one SLA: the full record, including the priority it gives each impact and urgency pair, plus its per-priority respond, plan and resolution targets. Read-only.",
    { id: z.number().int().positive().describe("SLA ID") },
    SETUP_READ_ONLY,
    async ({ id }) => {
      const sla = await client.get<CwRecord>(`/service/slas/${id}`);
      const priorities = await fetchAllPages<CwRecord>(client, `/service/slas/${id}/priorities`);
      return jsonContent({ ...sla, priorities });
    },
  );

  server.tool(
    "cw_trace_ticket_routing",
    "Trace why a service ticket sits on its board and team with its owner. Returns the ticket's board, team and owner; the ticket's audit trail lines about the owner; the board's auto-assign flags, auto-assign resources and role members; the ticket's team and the board's default team with their leaders; the email connectors that file to the board with their default members; and the board's active workflow rules with their events and actions. candidates lists every piece of setup that names the ticket's owner. A candidate is setup that could have set the owner, not proof: the audit trail says what happened. Event conditions are returned as ConnectWise holds them and are not evaluated against the ticket. A section that could not be read is named in unread with its error, and nothing is guessed for it. Read-only.",
    { ticketId: z.number().int().positive().describe("Service ticket ID") },
    SETUP_READ_ONLY,
    async ({ ticketId }) => {
      const ticket = await client.get<CwRecord>(`/service/tickets/${ticketId}`);
      const boardId = idOf(ticket.board);
      const unread: Array<{ section: string; error: string }> = [];
      const read = async <T>(section: string, fallback: T, run: () => Promise<T>): Promise<T> => {
        try {
          return await run();
        } catch (err: unknown) {
          unread.push({ section, error: errorMessage(err) });
          return fallback;
        }
      };

      const audit = await read("auditTrail", [] as CwRecord[], () =>
        fetchAllPages<CwRecord>(client, "/system/audittrail", { type: "Ticket", id: ticketId }),
      );

      let board: CwRecord | null = null;
      let autoAssignResources: CwRecord[] = [];
      let teams: CwRecord[] = [];
      let connectors: CwRecord[] = [];
      let workflowRules: CwRecord[] = [];
      if (boardId !== null) {
        board = await read("board", null as CwRecord | null, () =>
          client.get<CwRecord>(`/service/boards/${boardId}`),
        );
        autoAssignResources = await read("autoAssignResources", [] as CwRecord[], () =>
          fetchAllPages<CwRecord>(client, `/service/boards/${boardId}/autoAssignResources`),
        );
        teams = await read("teams", [] as CwRecord[], () => readTeams(client, boardId));
        connectors = await read("emailConnectors", [] as CwRecord[], () =>
          fetchAllPages<CwRecord>(client, "/system/emailConnectors", {
            conditions: `serviceBoard/id=${boardId}`,
          }),
        );
        workflowRules = await read("workflowRules", [] as CwRecord[], async () => {
          const rules = await fetchAllPages<CwRecord>(client, "/system/workflows", {
            conditions: `board/id=${boardId} and activateFlag=true`,
          });
          return mapWithConcurrency(rules, DETAIL_CONCURRENCY, async (rule) => ({
            ...toLeanWorkflowRule(rule),
            events: typeof rule.id === "number" ? await readWorkflowRuleDetail(client, rule.id) : [],
          }));
        });
      }

      const evidence: RoutingEvidence = {
        ticket,
        board,
        autoAssignResources,
        teams,
        connectors,
        workflowRules,
        audit,
      };
      const teamId = idOf(ticket.team);

      return jsonContent({
        ticket: toTraceTicket(ticket),
        ownerAudit: ownerAuditEntries(audit),
        auditEntryCount: audit.length,
        candidates: findOwnerCandidates(evidence),
        board: board ? toBoardAssignment(board) : null,
        autoAssignResources: autoAssignResources.map((resource) => ({
          id: resource.id ?? null,
          member: toRef(resource.member),
          notifyWho: toRef(resource.notifyWho),
        })),
        ticketTeam: teams.find((team) => team.id === teamId) ?? null,
        defaultTeam: teams.find((team) => team.defaultFlag === true) ?? null,
        emailConnectors: connectors.map(toLeanEmailConnector),
        workflowRules,
        conditionsEvaluated: false,
        unread,
      });
    },
  );
}

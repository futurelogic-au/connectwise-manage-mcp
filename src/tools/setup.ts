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
  "autoAssignLimitFlag",
  "autoAssignLimitAmount",
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
    ...pick(team, [
      "roundRobinFlag",
      "defaultRoundRobinFlag",
      "boardId",
      "locationId",
      "businessUnitId",
      "notifyOnTicketDelete",
    ]),
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
// Workflow event conditions
// ---------------------------------------------------------------------------

/** True, false, or null where the trace cannot tell. */
export type Tri = boolean | null;

export interface ConditionTerm {
  triggerId: number | null;
  /** The term in words, as ConnectWise describes it. */
  text: string;
  result: "true" | "false" | "unknown";
  /** Why a term is unknown. */
  reason?: string;
}

export interface ConditionMatch {
  result: "match" | "no-match" | "unknown";
  /** False when the condition text could not be read, so nothing was evaluated. */
  parsed: boolean;
  terms: ConditionTerm[];
}

type ConditionNode =
  | { kind: "term"; term: CwRecord }
  | { kind: "and" | "or"; nodes: ConditionNode[] };

type ConditionToken = "(" | ")" | "and" | "or" | CwRecord;

/**
 * Split an eventCondition into tokens. ConnectWise holds a condition as JSON
 * objects, one per term, joined by "and" and "or" with brackets for grouping.
 * Returns null for text that is not in that form.
 */
function tokeniseCondition(text: string): ConditionToken[] | null {
  const tokens: ConditionToken[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) {
      index++;
    } else if (char === "(" || char === ")") {
      tokens.push(char);
      index++;
    } else if (char === "{") {
      // Find the closing brace of this object, skipping braces inside strings.
      let depth = 0;
      let inString = false;
      let close = -1;
      for (let cursor = index; cursor < text.length; cursor++) {
        const current = text[cursor];
        if (inString) {
          if (current === "\\") cursor++;
          else if (current === '"') inString = false;
        } else if (current === '"') {
          inString = true;
        } else if (current === "{") {
          depth++;
        } else if (current === "}" && --depth === 0) {
          close = cursor;
          break;
        }
      }
      if (close < 0) return null;
      try {
        const parsed = asRecord(JSON.parse(text.slice(index, close + 1)));
        if (!parsed) return null;
        tokens.push(parsed);
      } catch {
        return null;
      }
      index = close + 1;
    } else {
      const word = /^(and|or)\b/i.exec(text.slice(index));
      if (!word) return null;
      tokens.push(word[1].toLowerCase() as "and" | "or");
      index += word[1].length;
    }
  }
  return tokens;
}

/** Parse tokens into a tree. "and" binds tighter than "or". */
function parseCondition(tokens: ConditionToken[]): ConditionNode | null {
  let position = 0;
  const primary = (): ConditionNode | null => {
    const token = tokens[position];
    if (token === "(") {
      position++;
      const inner = either();
      if (!inner || tokens[position] !== ")") return null;
      position++;
      return inner;
    }
    if (token === undefined || typeof token === "string") return null;
    position++;
    return { kind: "term", term: token };
  };
  const chain = (kind: "and" | "or", next: () => ConditionNode | null) => (): ConditionNode | null => {
    const first = next();
    if (!first) return null;
    const nodes = [first];
    while (tokens[position] === kind) {
      position++;
      const more = next();
      if (!more) return null;
      nodes.push(more);
    }
    return nodes.length === 1 ? first : { kind, nodes };
  };
  const both = chain("and", primary);
  const either: () => ConditionNode | null = chain("or", both);
  const tree = either();
  return tree && position === tokens.length ? tree : null;
}

/**
 * The triggers the trace evaluates, by the id ConnectWise gives them in
 * /system/workflows/{id}/triggers. Only triggers seen in a live condition are
 * here (and SR-ActualAgeLessThan, the mirror of 239). Every other trigger is
 * reported as unknown, never guessed.
 */
const TRIGGER_STATUS = 33;
const TRIGGER_PRIORITY = 19;
const TRIGGER_ACTUAL_AGE_LESS = 238;
const TRIGGER_ACTUAL_AGE_MORE = 239;

function evaluateTerm(term: CwRecord, ticket: CwRecord, now: Date): ConditionTerm {
  const value = asRecord(term.value) ?? {};
  const raw = typeof value.value === "string" || typeof value.value === "number" ? String(value.value) : "";
  const shown = typeof value.description === "string" && value.description ? value.description : raw;
  const template = typeof term.description === "string" ? term.description : "";
  const triggerId = typeof term.triggerId === "number" ? term.triggerId : null;
  const text = template ? template.replace("{value}", shown) : `trigger ${triggerId ?? "?"} ${shown}`.trim();
  const done = (result: Tri, reason?: string): ConditionTerm => ({
    triggerId,
    text,
    result: result === null ? "unknown" : result ? "true" : "false",
    ...(result === null && reason ? { reason } : {}),
  });

  const wanted = Number(raw);
  if (triggerId === TRIGGER_STATUS || triggerId === TRIGGER_PRIORITY) {
    if (raw === "" || !Number.isInteger(wanted)) return done(null, "The term holds no id to compare.");
    return done(idOf(triggerId === TRIGGER_STATUS ? ticket.status : ticket.priority) === wanted);
  }
  if (triggerId === TRIGGER_ACTUAL_AGE_MORE || triggerId === TRIGGER_ACTUAL_AGE_LESS) {
    const entered = asRecord(ticket._info)?.dateEntered;
    const enteredAt = typeof entered === "string" ? Date.parse(entered) : NaN;
    if (raw === "" || Number.isNaN(wanted) || Number.isNaN(enteredAt)) {
      return done(null, "The term or the ticket holds no value to compare.");
    }
    if (ticket.closedFlag === true) return done(null, "The ticket is closed, so its age now is not its age when the rule ran.");
    const hours = (now.getTime() - enteredAt) / 3_600_000;
    return done(triggerId === TRIGGER_ACTUAL_AGE_MORE ? hours > wanted : hours < wanted);
  }
  return done(null, "This trigger is not one the trace evaluates.");
}

function triAnd(values: Tri[]): Tri {
  if (values.includes(false)) return false;
  return values.includes(null) ? null : true;
}

function triOr(values: Tri[]): Tri {
  if (values.includes(true)) return true;
  return values.includes(null) ? null : false;
}

/**
 * Evaluate one workflow event condition against a ticket as the ticket is now.
 * A term the trace cannot evaluate is unknown, and an unknown term makes the
 * whole condition unknown unless the other terms settle it.
 */
export function evaluateEventCondition(condition: unknown, ticket: CwRecord, now: Date = new Date()): ConditionMatch {
  const tokens = typeof condition === "string" ? tokeniseCondition(condition) : null;
  const tree = tokens && tokens.length > 0 ? parseCondition(tokens) : null;
  if (!tree) return { result: "unknown", parsed: false, terms: [] };

  const terms: ConditionTerm[] = [];
  const walk = (node: ConditionNode): Tri => {
    if (node.kind === "term") {
      const term = evaluateTerm(node.term, ticket, now);
      terms.push(term);
      return term.result === "unknown" ? null : term.result === "true";
    }
    const values = node.nodes.map(walk);
    return node.kind === "and" ? triAnd(values) : triOr(values);
  };
  const result = walk(tree);
  return { result: result === null ? "unknown" : result ? "match" : "no-match", parsed: true, terms };
}

// ---------------------------------------------------------------------------
// Routing trace
// ---------------------------------------------------------------------------

/** A member as the trace knows them. A name read from the audit trail has no id. */
export interface TraceMember {
  id: number | null;
  identifier?: string | null;
  name: string | null;
}

export interface OwnerChange {
  from: string;
  to: string;
  enteredDate: string | null;
  enteredBy: string | null;
}

export interface AuditFacts {
  /** Owner changes, oldest first. */
  ownerChanges: OwnerChange[];
  /** Members the board assigned by itself, in the order it assigned them. */
  autoAssigned: string[];
  /** Workflow events the audit trail says ran on the ticket. */
  workflowRuns: Array<{ rule: string; eventId: number; count: number; first: string | null; last: string | null }>;
}

const OWNER_CHANGE = /^Owner has been updated from "(.*)" to "(.*)"\.?\s*$/;
const AUTO_ASSIGNED = /automatic assignment\.[\s\S]*Member:\s*(.+?)\s*$/;
const WORKFLOW_RAN = /^Workflow "(.+)" ran on this ticket\. EventID: "(\d+)"/;

/**
 * Read the facts the trace needs from a ticket's audit trail. ConnectWise
 * returns the trail newest first, so it is reversed here: lines written in the
 * same second then stay in the order they were written.
 */
export function readAuditFacts(audit: CwRecord[]): AuditFacts {
  const facts: AuditFacts = { ownerChanges: [], autoAssigned: [], workflowRuns: [] };
  const oldestFirst = [...audit]
    .reverse()
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const left = typeof a.entry.enteredDate === "string" ? Date.parse(a.entry.enteredDate) : 0;
      const right = typeof b.entry.enteredDate === "string" ? Date.parse(b.entry.enteredDate) : 0;
      return left - right || a.index - b.index;
    })
    .map((item) => item.entry);

  for (const entry of oldestFirst) {
    const text = typeof entry.text === "string" ? entry.text.replace(/\\n/g, "\n") : "";
    const enteredDate = typeof entry.enteredDate === "string" ? entry.enteredDate : null;
    const enteredBy = typeof entry.enteredBy === "string" ? entry.enteredBy : null;

    const owner = OWNER_CHANGE.exec(text);
    if (owner) {
      facts.ownerChanges.push({ from: owner[1], to: owner[2], enteredDate, enteredBy });
      continue;
    }
    const assigned = AUTO_ASSIGNED.exec(text);
    if (assigned) {
      facts.autoAssigned.push(assigned[1]);
      continue;
    }
    const ran = WORKFLOW_RAN.exec(text);
    if (ran) {
      const eventId = Number(ran[2]);
      const known = facts.workflowRuns.find((run) => run.rule === ran[1] && run.eventId === eventId);
      if (known) {
        known.count++;
        known.last = enteredDate;
      } else {
        facts.workflowRuns.push({ rule: ran[1], eventId, count: 1, first: enteredDate, last: enteredDate });
      }
    }
  }
  return facts;
}

function sameName(left: unknown, right: unknown): boolean {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    left.trim() !== "" &&
    left.trim().toLowerCase() === right.trim().toLowerCase()
  );
}

/** True when a ConnectWise reference is this member: by id where both have one, else by name. */
function isMember(reference: unknown, member: TraceMember): boolean {
  const record = asRecord(reference);
  if (!record) return false;
  if (typeof record.id === "number" && member.id !== null) return record.id === member.id;
  return sameName(record.name, member.name);
}

/**
 * The owner the ticket arrived with. The first owner change in the audit trail
 * names it. With no owner change, the current owner is the owner it arrived
 * with. The audit trail gives a name only, so the id is looked up in the teams.
 */
export function findArrivedOwner(
  ticket: CwRecord,
  facts: AuditFacts,
  teams: CwRecord[],
): (TraceMember & { basis: string }) | null {
  const current = toRef(ticket.owner);
  const first = facts.ownerChanges[0];
  if (!first) {
    return current
      ? { ...current, basis: "The audit trail holds no owner change, so the current owner is the first owner." }
      : null;
  }
  const basis = "The first owner change in the audit trail was from this member.";
  if (first.from.trim() === "") return null;
  if (current && sameName(current.name, first.from)) return { ...current, basis };
  for (const team of teams) {
    const candidates = [team.teamLeader, ...((team.members as unknown[] | undefined) ?? [])];
    const found = candidates.map(asRecord).find((member) => member && sameName(member.name, first.from));
    if (found && typeof found.id === "number") {
      return {
        id: found.id,
        identifier: typeof found.identifier === "string" ? found.identifier : null,
        name: first.from,
        basis,
      };
    }
  }
  return { id: null, name: first.from, basis };
}

/** What the trace read for one ticket, before any conclusion is drawn. */
export interface RoutingEvidence {
  ticket: CwRecord;
  board: CwRecord | null;
  autoAssignResources: CwRecord[];
  teams: CwRecord[];
  connectors: CwRecord[];
  workflowRules: CwRecord[];
  facts: AuditFacts;
}

export interface OwnerCandidate {
  source:
    | "board-auto-assign"
    | "workflow-action"
    | "email-connector-default-member"
    | "board-auto-assign-resource"
    | "team-leader"
    | "board-role-member"
    | "entered-by-owner";
  /** "audit" when the audit trail shows it happened, "setup" when the setup only allows it. */
  evidence: "audit" | "setup";
  detail: string;
  [key: string]: unknown;
}

/**
 * List every piece of setup that explains why this member owned the ticket.
 * A candidate with evidence "audit" is backed by a line in the audit trail. A
 * candidate with evidence "setup" is setup that names the member and could
 * have set the owner, not proof that it did.
 */
export function findOwnerCandidates(evidence: RoutingEvidence, owner: TraceMember | null): OwnerCandidate[] {
  if (!owner) return [];
  const boardId = idOf(evidence.ticket.board);
  const teamId = idOf(evidence.ticket.team);
  const candidates: OwnerCandidate[] = [];
  const boardFlags = evidence.board ? pick(evidence.board, BOARD_ASSIGN_FLAGS) : {};

  const position = evidence.facts.autoAssigned.findIndex((name) => sameName(name, owner.name));
  if (position >= 0) {
    const ownerFlag = evidence.board?.autoAssignTicketOwnerFlag === true;
    candidates.push({
      source: "board-auto-assign",
      evidence: "audit",
      detail:
        `The audit trail shows the board assigned ${evidence.facts.autoAssigned.length} member(s) by itself when the ticket was created, and this member was number ${position + 1}. ` +
        (ownerFlag
          ? "The board's autoAssignTicketOwnerFlag is on, so the board also sets the owner from that assignment."
          : "The board's autoAssignTicketOwnerFlag is not on, so this assignment made the member a resource, not the owner."),
      position: position + 1,
      autoAssigned: evidence.facts.autoAssigned,
      boardFlags,
      resources: evidence.autoAssignResources.map((resource) => ({
        member: toRef(resource.member),
        notifyWho: toRef(resource.notifyWho),
      })),
    });
  }

  for (const rule of evidence.workflowRules) {
    for (const event of (rule.events as CwRecord[] | undefined) ?? []) {
      for (const action of (event.actions as CwRecord[] | undefined) ?? []) {
        if (!isMember(action.specificMemberTo, owner)) continue;
        const ran = evidence.facts.workflowRuns.some((run) => run.eventId === event.id);
        candidates.push({
          source: "workflow-action",
          evidence: ran ? "audit" : "setup",
          detail:
            `Workflow rule "${String(rule.name)}", event "${String(event.name)}" has an action that names this member. ` +
            (ran ? "The audit trail shows this event ran on the ticket." : "The audit trail does not show this event ran on the ticket."),
          rule: { id: rule.id ?? null, name: rule.name ?? null },
          event: { id: event.id ?? null, name: event.name ?? null },
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
    if (!isMember(connector.defaultMember, owner)) continue;
    if (boardId !== null && idOf(connector.serviceBoard) !== boardId) continue;
    candidates.push({
      source: "email-connector-default-member",
      evidence: "setup",
      detail: "An email connector that files to this board has this member as its default member.",
      connector: { id: connector.id ?? null, mailbox: connectorMailbox(connector) },
    });
  }

  if (position < 0 && evidence.autoAssignResources.some((resource) => isMember(resource.member, owner))) {
    candidates.push({
      source: "board-auto-assign-resource",
      evidence: "setup",
      detail: "This member is an auto-assign resource on the board.",
      boardFlags,
    });
  }

  for (const team of evidence.teams) {
    if (!isMember(team.teamLeader, owner)) continue;
    if (team.id !== teamId && team.defaultFlag !== true) continue;
    candidates.push({
      source: "team-leader",
      evidence: "setup",
      detail:
        team.id === teamId
          ? "This member leads the ticket's team."
          : "This member leads the board's default team.",
      team: {
        id: team.id ?? null,
        name: team.name ?? null,
        defaultFlag: team.defaultFlag === true,
        ...pick(team, ["roundRobinFlag", "defaultRoundRobinFlag"]),
      },
    });
  }

  if (evidence.board) {
    const roles = BOARD_ROLE_MEMBERS.filter((role) => isMember(evidence.board?.[role], owner));
    if (roles.length > 0) {
      candidates.push({
        source: "board-role-member",
        evidence: "setup",
        detail: `This member holds a board role: ${roles.join(", ")}.`,
        roles,
      });
    }
  }

  const enteredBy = asRecord(evidence.ticket._info)?.enteredBy;
  if (sameName(enteredBy, owner.identifier)) {
    candidates.push({
      source: "entered-by-owner",
      evidence: "setup",
      detail: "This member is the member the ticket was entered by.",
      enteredBy,
    });
  }

  return candidates;
}

function connectorMailbox(connector: CwRecord): string | null {
  for (const key of ["office365EmailSetup", "imapSetup", "googleEmailSetup"]) {
    const name = asRecord(connector[key])?.name;
    if (typeof name === "string") return name;
  }
  return null;
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
    ...pick(ticket, ["recordType", "closedFlag", "resources", "parentTicketId"]),
    _info: pick(info, ["dateEntered", "enteredBy", "lastUpdated", "updatedBy"]),
  };
}

const TRACE_ACTION_REFS = [
  "notifyType",
  "notifyWho",
  "notifyFrom",
  "specificMemberTo",
  "specificTeamTo",
  "board",
  "boardStatus",
  "serviceType",
  "serviceSubType",
  "serviceItem",
  "servicePriority",
  "serviceTemplate",
];

/** A workflow event as the trace returns it: what it does and whether it matches. */
function toTraceEvent(event: CwRecord, ticket: CwRecord, facts: AuditFacts, now: Date): CwRecord {
  const ran = facts.workflowRuns.find((run) => run.eventId === event.id);
  return {
    id: event.id ?? null,
    name: event.name ?? null,
    ...pick(event, ["frequencyOfExecution", "frequencyUnit", "executionTime", "maxNumberOfExecution"]),
    conditionMatch: evaluateEventCondition(event.eventCondition, ticket, now),
    ranOnTicket: ran ? { count: ran.count, first: ran.first, last: ran.last } : { count: 0 },
    actions: ((event.actions as CwRecord[] | undefined) ?? []).map((action) => ({
      id: action.id ?? null,
      ...pickRefs(action, TRACE_ACTION_REFS),
      ...pick(action, ["emailRecipient", "subject", "updateOwnerFlag", "daysToExecute"]),
    })),
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
    "Trace why a service ticket sits on its board and team, and why it had the owner it arrived with. Returns the ticket's board, team and current owner; arrivedOwner, the owner before the first owner change in the audit trail; ownerChanges, every owner change since; autoAssigned, the members the board assigned by itself at creation; candidates, every piece of setup that explains the arrived owner (evidence 'audit' when the audit trail shows it happened, 'setup' when the setup only allows it); the board's auto-assign flags, auto-assign resources and role members; the ticket's team and the board's default team with leaders, members and round robin flags; the email connectors that file to the board; and the board's active workflow rules. Each workflow event carries conditionMatch, its condition evaluated against the ticket as it is now (status, priority and actual age terms are evaluated, any other trigger is 'unknown'), and ranOnTicket, how often the audit trail says the event ran on this ticket. A section that could not be read is named in unread with its error, and nothing is guessed for it. Read-only.",
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

      const facts = readAuditFacts(audit);
      const evidence: RoutingEvidence = {
        ticket,
        board,
        autoAssignResources,
        teams,
        connectors,
        workflowRules,
        facts,
      };
      const arrivedOwner = findArrivedOwner(ticket, facts, teams);
      const teamId = idOf(ticket.team);
      const ticketTeam = teams.find((team) => team.id === teamId) ?? null;
      const defaultTeam = teams.find((team) => team.defaultFlag === true) ?? null;
      const now = new Date();

      return jsonContent({
        ticket: toTraceTicket(ticket),
        arrivedOwner,
        ownerChanges: facts.ownerChanges,
        autoAssigned: facts.autoAssigned,
        candidates: findOwnerCandidates(evidence, arrivedOwner),
        auditEntryCount: audit.length,
        board: board ? toBoardAssignment(board) : null,
        autoAssignResources: autoAssignResources.map((resource) => ({
          id: resource.id ?? null,
          member: toRef(resource.member),
          notifyWho: toRef(resource.notifyWho),
        })),
        ticketTeam,
        defaultTeam:
          defaultTeam && ticketTeam && defaultTeam.id === ticketTeam.id
            ? { id: defaultTeam.id, name: defaultTeam.name, sameAsTicketTeam: true }
            : defaultTeam,
        emailConnectors: connectors.map(toLeanEmailConnector),
        workflowRules: workflowRules.map((rule) => ({
          ...rule,
          events: ((rule.events as CwRecord[] | undefined) ?? []).map((event) =>
            toTraceEvent(event, ticket, facts, now),
          ),
        })),
        conditionsEvaluatedAt: now.toISOString(),
        unread,
      });
    },
  );
}

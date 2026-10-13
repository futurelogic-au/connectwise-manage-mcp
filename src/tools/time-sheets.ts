import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient } from "../api-client.js";
import { andConditions, fetchAllPages } from "./paging.js";
import { operationsMissingValue, ticketPatchOperationSchema } from "./ticket-lean.js";

/**
 * Time sheet tools (ConnectWise Time API, /time/sheets).
 *
 * A time sheet is one member's time for one Saturday to Friday period. These
 * tools find and read sheets, submit them, approve, reject and reverse them at
 * tier one, edit a time entry on an approved sheet through a guided reverse,
 * edit, submit and approve, and list the sheets that are missing. Approval feeds billing,
 * so every write needs confirm: true and is read back.
 */

const TIME_SHEET_READ_ONLY = { readOnlyHint: true };
/** Approving, rejecting or reversing a sheet changes what bills. */
const TIME_SHEET_WRITE = { readOnlyHint: false, destructiveHint: true };

/**
 * The approvalType ConnectWise takes for a tier one approval. The status a
 * good approval reads back is ApprovedByTierOne, but that is not the value the
 * call takes: the published contract lists DataEntry, Tier1Update,
 * Tier2Update, Billing, Service, Project, MonthlySummary, SalesActivity and
 * Schedule. D19: tier one only, so no other value is ever sent.
 */
export const TIER_ONE_APPROVAL_TYPE = "Tier1Update";

const STATUS_APPROVED_TIER_ONE = "ApprovedByTierOne";
const STATUS_REJECTED = "Rejected";
const STATUS_OPEN = "Open";
/** A sheet that has been submitted and waits for a tier one decision. */
const SUBMITTED_STATUSES = ["PendingApproval", "ErrorsCorrected"];
/** D21: a sheet in one of these statuses has not been submitted. */
export const NOT_SUBMITTED_STATUSES = ["Open", "Rejected"];

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Perth is UTC+8 all year. */
const PERTH_OFFSET_MS = 8 * HOUR_MS;

type CwRecord = Record<string, unknown>;

function jsonText(value: unknown) {
  return { type: "text" as const, text: JSON.stringify(value, null, 2) };
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

const pad = (value: number) => String(value).padStart(2, "0");
/** The calendar date of a Date read through its UTC fields, as YYYY-MM-DD. */
const ymd = (date: Date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
/** YYYY-MM-DD to dd/mm/yyyy. */
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** The lean shape of a time sheet. */
export function toLeanTimeSheet(sheet: CwRecord): CwRecord {
  const member = asRecord(sheet.member);
  const info = asRecord(sheet._info) ?? {};
  const start = typeof sheet.dateStart === "string" ? sheet.dateStart.slice(0, 10) : null;
  const end = typeof sheet.dateEnd === "string" ? sheet.dateEnd.slice(0, 10) : null;
  return {
    id: sheet.id ?? null,
    member: member
      ? { id: member.id ?? null, identifier: member.identifier ?? null, name: member.name ?? null }
      : null,
    status: sheet.status ?? null,
    hours: sheet.hours ?? null,
    // ConnectWise holds the period as two dates at midnight UTC. They are calendar dates, not moments.
    dateStart: start,
    dateEnd: end,
    label: start && end ? `${dmy(start)} to ${dmy(end)}` : null,
    year: sheet.year ?? null,
    period: sheet.period ?? null,
    deadline: sheet.deadline ?? null,
    _info: { lastUpdated: info.lastUpdated ?? null, updatedBy: info.updatedBy ?? null },
  };
}

// ---------------------------------------------------------------------------
// Before and after values
// ---------------------------------------------------------------------------

/**
 * Show a field value the way the Timesheet Review change log shows it: a
 * reference by its name, then its identifier, then "id N"; notes cut at 200
 * characters. The guided flow's from and to values are compared with that log,
 * so this must stay in step with display() in its changelog-lib.js.
 */
export function displayValue(field: string, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") {
    const record = value as CwRecord;
    if (typeof record.name === "string" && record.name) return record.name;
    if (typeof record.identifier === "string" && record.identifier) return record.identifier;
    return record.id !== undefined ? `id ${String(record.id)}` : JSON.stringify(value);
  }
  const text = String(value);
  return (field === "notes" || field === "internalNotes") && text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

/** A value with every nested _info block removed, so a changed href is not read as a changed value. */
function withoutInfo(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutInfo);
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => key !== "_info")
      .map(([key, inner]) => [key, withoutInfo(inner)]),
  );
}

export interface FieldChange {
  field: string;
  /** The value before, as the change log shows it. */
  from: string;
  /** The value after, as the change log shows it. */
  to: string;
  before: unknown;
  after: unknown;
}

/**
 * Every top-level field that differs between two reads of one record. _info is
 * left out: it holds the last-updated stamp, which changes on every write.
 */
export function diffRecords(before: CwRecord, after: CwRecord): FieldChange[] {
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => key !== "_info");
  const changes: FieldChange[] = [];
  for (const field of fields.sort()) {
    const left = withoutInfo(before[field]);
    const right = withoutInfo(after[field]);
    if (JSON.stringify(left) === JSON.stringify(right)) continue;
    changes.push({
      field,
      from: displayValue(field, before[field]),
      to: displayValue(field, after[field]),
      before: left ?? null,
      after: right ?? null,
    });
  }
  return changes;
}

/** The top-level field a JSON Patch path changes: "billableOption", or "workType" for "workType/id". */
function fieldOfPath(path: string): string {
  return path.split("/").filter(Boolean)[0] ?? "";
}

// ---------------------------------------------------------------------------
// Missing time sheets (D21)
// ---------------------------------------------------------------------------

export interface HolidayData {
  /** Holiday dates (YYYY-MM-DD) by holiday list name. */
  lists: Record<string, string[]>;
  /** The holiday list each member's calendar points at, by member identifier. */
  members: Record<string, string>;
  /** The Western Australia list, used for a member whose calendar names no list. */
  waList: string | null;
}

/** Monday to Friday and not a public holiday on the member's list. The date is read through its UTC fields. */
export function isBusinessDay(date: Date, identifier: string | undefined, holidays: HolidayData): boolean {
  const listName = (identifier && holidays.members[identifier]) || holidays.waList;
  const dates = (listName && holidays.lists[listName]) || [];
  const day = date.getUTCDay();
  return day >= 1 && day <= 5 && !dates.includes(ymd(date));
}

/**
 * A "Perth clock": a Date whose UTC fields read as Perth local time. Takes a
 * Perth local time as YYYY-MM-DDTHH:mm, or uses the time now.
 */
export function perthClock(now?: string): Date {
  if (now !== undefined) return new Date(`${now}:00Z`);
  return new Date(Date.now() + PERTH_OFFSET_MS);
}

export interface MissingSheetInput {
  sheets: CwRecord[];
  /** Active members only. */
  members: CwRecord[];
  holidays: HolidayData;
  /** A Perth clock, from perthClock(). */
  now: Date;
  excludeMembers: string[];
  dueHourPerth: number;
}

export interface MissingPeriod {
  sheetId: number | null;
  start: string;
  end: string;
  label: string;
  status: string;
  hours: number | null;
  /** The due day in Perth, YYYY-MM-DD: the first business day after the period. */
  dueDay: string;
  /** 0 on the due day after the due hour, 1 on the next business day, and so on. */
  businessDaysOverdue: number;
}

export interface MissingPerson {
  identifier: string;
  name: string | null;
  firstName: string | null;
  email: string | null;
  holidayList: string | null;
  periods: MissingPeriod[];
}

/**
 * D21: the time sheets that are missing at a moment. A sheet is missing when
 * it is Open or Rejected after the due hour, Perth time, on the first business
 * day after its Saturday to Friday period. Business days come from each
 * member's own holiday list. Active members only.
 *
 * This follows overdue-check.js in the Timesheet Review tooling step for step,
 * so the two give the same people, periods and business days overdue.
 */
export function findMissingSheets(input: MissingSheetInput): MissingPerson[] {
  const { sheets, members, holidays, now, excludeMembers, dueHourPerth } = input;
  const byIdentifier = new Map<string, CwRecord>();
  for (const member of members) {
    if (typeof member.identifier === "string") byIdentifier.set(member.identifier, member);
  }
  const midnight = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const today = ymd(now);
  const people = new Map<string, MissingPerson>();

  for (const sheet of sheets) {
    const sheetMember = asRecord(sheet.member);
    const identifier = typeof sheetMember?.identifier === "string" ? sheetMember.identifier : undefined;
    if (!identifier || excludeMembers.includes(identifier)) continue;
    const member = byIdentifier.get(identifier);
    if (!member) continue;
    if (typeof sheet.status !== "string" || !NOT_SUBMITTED_STATUSES.includes(sheet.status)) continue;
    if (typeof sheet.dateStart !== "string" || typeof sheet.dateEnd !== "string") continue;

    // The period ends on a Friday. It is due on the first business day after it:
    // Monday, or later when Monday is a public holiday for this member.
    const dueDay = new Date(Date.parse(sheet.dateEnd) + 3 * DAY_MS);
    while (!isBusinessDay(midnight(dueDay), identifier, holidays)) dueDay.setUTCDate(dueDay.getUTCDate() + 1);
    if (now.getTime() < dueDay.getTime() + dueHourPerth * HOUR_MS) continue;

    let businessDaysOverdue = 0;
    const cursor = midnight(dueDay);
    while (ymd(cursor) < today) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      if (isBusinessDay(cursor, identifier, holidays)) businessDaysOverdue++;
    }

    let person = people.get(identifier);
    if (!person) {
      person = {
        identifier,
        name: typeof sheetMember?.name === "string" ? sheetMember.name : null,
        firstName: typeof member.firstName === "string" ? member.firstName : null,
        email: typeof member.officeEmail === "string" ? member.officeEmail : null,
        holidayList: holidays.members[identifier] ?? holidays.waList,
        periods: [],
      };
      people.set(identifier, person);
    }
    const start = sheet.dateStart.slice(0, 10);
    const end = sheet.dateEnd.slice(0, 10);
    person.periods.push({
      sheetId: typeof sheet.id === "number" ? sheet.id : null,
      start,
      end,
      label: `${dmy(start)} to ${dmy(end)}`,
      status: sheet.status,
      hours: typeof sheet.hours === "number" ? sheet.hours : null,
      dueDay: ymd(dueDay),
      businessDaysOverdue,
    });
  }
  return [...people.values()];
}

/**
 * Read each member's public holidays from ConnectWise: the member's calendar
 * names a holiday list, and the list holds the dates. The Western Australia
 * list (its name ends "- WA") is the fall back for a member with no list.
 */
async function readHolidays(client: CwManageClient, members: CwRecord[]): Promise<HolidayData> {
  const calendars = await fetchAllPages<CwRecord>(client, "/schedule/calendars", { fields: "id,name,holidayList" });
  const listByCalendar = new Map<number, { id: number; name: string }>();
  const listIds = new Map<string, number>();
  for (const calendar of calendars) {
    const list = asRecord(calendar.holidayList);
    if (typeof calendar.id !== "number" || typeof list?.id !== "number" || typeof list.name !== "string") continue;
    listByCalendar.set(calendar.id, { id: list.id, name: list.name });
    listIds.set(list.name, list.id);
  }

  const data: HolidayData = { lists: {}, members: {}, waList: null };
  for (const member of members) {
    const calendarId = idOf(member.calendar);
    const list = calendarId === null ? undefined : listByCalendar.get(calendarId);
    if (list && typeof member.identifier === "string") data.members[member.identifier] = list.name;
  }
  // The fall back list is read even when no member names it, so a member with no calendar still has one.
  const waName = [...listIds.keys()].find((name) => /- WA$/i.test(name)) ?? null;
  data.waList = waName;
  const wanted = new Set([...Object.values(data.members), ...(waName ? [waName] : [])]);
  for (const name of wanted) {
    const holidays = await fetchAllPages<CwRecord>(client, `/schedule/holidayLists/${listIds.get(name)}/holidays`, {
      fields: "date",
    });
    data.lists[name] = holidays
      .map((holiday) => (typeof holiday.date === "string" ? holiday.date.slice(0, 10) : ""))
      .filter(Boolean)
      .sort();
  }
  return data;
}

// ---------------------------------------------------------------------------
// Status changes
// ---------------------------------------------------------------------------

type SheetAction = "submit" | "approve" | "reject" | "reverse";

interface StatusChange {
  ok: boolean;
  statusBefore: string | null;
  statusAfter: string | null;
  error?: string;
}

const statusOf = (sheet: CwRecord | null) => (typeof sheet?.status === "string" ? sheet.status : null);

/** True when the status read back is the one this action should leave. */
function landed(action: SheetAction, statusAfter: string | null): boolean {
  if (action === "submit") return statusAfter !== null && SUBMITTED_STATUSES.includes(statusAfter);
  if (action === "approve") return statusAfter === STATUS_APPROVED_TIER_ONE;
  if (action === "reject") return statusAfter === STATUS_REJECTED;
  // On the live server a reverse takes the approval off and un-submits the sheet: it reads Open.
  return statusAfter === STATUS_OPEN;
}

/** A submit takes no body. Approve, reject and reverse take the tier one approval type. */
const bodyFor = (action: SheetAction) => (action === "submit" ? {} : { approvalType: TIER_ONE_APPROVAL_TYPE });

/** Send one tier one status change and read the sheet back. Never throws: a failure is returned. */
async function changeSheetStatus(
  client: CwManageClient,
  sheetId: number,
  action: SheetAction,
  statusBefore: string | null,
): Promise<StatusChange> {
  try {
    await client.post(`/time/sheets/${sheetId}/${action}`, bodyFor(action));
  } catch (err: unknown) {
    return { ok: false, statusBefore, statusAfter: statusBefore, error: errorMessage(err) };
  }
  try {
    const statusAfter = statusOf(await client.get<CwRecord>(`/time/sheets/${sheetId}`));
    return landed(action, statusAfter)
      ? { ok: true, statusBefore, statusAfter }
      : {
          ok: false,
          statusBefore,
          statusAfter,
          error: `ConnectWise accepted the ${action}, but the sheet reads ${statusAfter ?? "no status"}.`,
        };
  } catch (err: unknown) {
    return {
      ok: false,
      statusBefore,
      statusAfter: null,
      error: `The ${action} was sent but the read back failed: ${errorMessage(err)}`,
    };
  }
}

const ALLOWED_FROM: Record<SheetAction, string[]> = {
  submit: NOT_SUBMITTED_STATUSES,
  approve: SUBMITTED_STATUSES,
  reject: SUBMITTED_STATUSES,
  reverse: [STATUS_APPROVED_TIER_ONE],
};

/** ConnectWise's refusal of a sheet reject when no time entry on the sheet is rejected. */
const ENTRIES_NOT_REJECTED = /reject the incorrect time entries/i;

const PAST_TENSE: Record<SheetAction, string> = {
  submit: "submitted",
  approve: "approved",
  reject: "rejected",
  reverse: "reversed",
};

/** The shared handler for approve, reject and reverse: guard, plan, write, read back. */
async function runSheetAction(
  client: CwManageClient,
  action: SheetAction,
  args: { id: number; reason?: string; confirm?: boolean },
) {
  const before = await client.get<CwRecord>(`/time/sheets/${args.id}`);
  const statusBefore = statusOf(before);
  const sheet = toLeanTimeSheet(before);
  const reason = args.reason === undefined ? {} : { reason: args.reason };

  if (!statusBefore || !ALLOWED_FROM[action].includes(statusBefore)) {
    return {
      content: [
        jsonText({
          saved: false,
          message: `Time sheet ${args.id} is ${statusBefore ?? "in no status"}, so it is not ${PAST_TENSE[action]}. This tool takes a sheet that is ${ALLOWED_FROM[action].join(" or ")}. Nothing was changed.`,
          timeSheet: sheet,
        }),
      ],
      isError: true,
    };
  }
  if (args.confirm !== true) {
    return {
      content: [
        jsonText({
          saved: false,
          message: `No write was made. Pass confirm: true to ${action} this time sheet.`,
          planned: { call: `POST /time/sheets/${args.id}/${action}`, ...bodyFor(action) },
          ...reason,
          timeSheet: sheet,
        }),
      ],
      isError: true,
    };
  }

  const change = await changeSheetStatus(client, args.id, action, statusBefore);
  let after: CwRecord | null = null;
  try {
    after = await client.get<CwRecord>(`/time/sheets/${args.id}`);
  } catch {
    /* reported through change.ok */
  }
  return {
    content: [
      jsonText({
        saved: change.error === undefined || change.statusAfter !== statusBefore,
        verified: change.ok,
        action,
        ...bodyFor(action),
        statusBefore: change.statusBefore,
        statusAfter: change.statusAfter,
        ...reason,
        ...(change.error ? { error: change.error } : {}),
        ...(action === "reject" && change.error && ENTRIES_NOT_REJECTED.test(change.error)
          ? {
              refusal: "entries-not-rejected",
              message:
                "ConnectWise rejects a time sheet only after at least one of its time entries is rejected. The API cannot reject a time entry, so reject the incorrect entries in Manage first, then run this again. Nothing was changed.",
            }
          : {}),
        timeSheet: after ? toLeanTimeSheet(after) : sheet,
      }),
    ],
    isError: !change.ok,
  };
}

/** Paths the guided edit refuses: they would move the entry off its sheet or to another member. */
const GUIDED_EDIT_REFUSED_FIELDS = ["id", "member", "timeSheet"];

/**
 * Register the time sheet tools on the MCP server.
 *
 * @param server MCP server to register tools on.
 * @param client ConnectWise Manage client used by the tools.
 */
export function registerTimeSheetTools(server: McpServer, client: CwManageClient) {
  server.tool(
    "cw_search_time_sheets",
    "Search time sheets (GET /time/sheets). A time sheet is one member's time for one Saturday to Friday period. Each row is lean: id, member, status, hours, dateStart, dateEnd, a dd/mm/yyyy label, year, period, deadline and _info.lastUpdated. Filter by member, status or the date the period starts. Reads all pages, newest period first. Status is one of Open, Rejected, PendingApproval, ErrorsCorrected, PendingProjectApproval, ApprovedByTierOne, RejectBySecondTier, ApprovedByTierTwo, ReadyToBill, Billed, WrittenOff or BilledAgreement. Read-only.",
    {
      memberIdentifier: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9._-]+$/, "Letters, digits, dot, dash and underscore only")
        .optional()
        .describe("Only this member's sheets, by member identifier, for example sjenner"),
      memberId: z.number().int().positive().optional().describe("Only this member's sheets, by member ID"),
      status: z
        .string()
        .trim()
        .regex(/^[A-Za-z]+$/, "A status name, letters only")
        .optional()
        .describe("Only sheets in this status, for example PendingApproval"),
      periodStartFrom: z
        .string()
        .regex(/^\d{4}-\d\d-\d\d$/, "YYYY-MM-DD")
        .optional()
        .describe("Only periods that start on or after this date (YYYY-MM-DD)"),
      periodStartTo: z
        .string()
        .regex(/^\d{4}-\d\d-\d\d$/, "YYYY-MM-DD")
        .optional()
        .describe("Only periods that start on or before this date (YYYY-MM-DD)"),
      conditions: z.string().optional().describe("ConnectWise conditions query string, added to the filters above"),
    },
    TIME_SHEET_READ_ONLY,
    async ({ memberIdentifier, memberId, status, periodStartFrom, periodStartTo, conditions }) => {
      const sheets = await fetchAllPages<CwRecord>(client, "/time/sheets", {
        conditions: andConditions(
          memberIdentifier === undefined ? undefined : `member/identifier='${memberIdentifier}'`,
          memberId === undefined ? undefined : `member/id=${memberId}`,
          status === undefined ? undefined : `status='${status}'`,
          periodStartFrom === undefined ? undefined : `dateStart>=[${periodStartFrom}]`,
          periodStartTo === undefined ? undefined : `dateStart<=[${periodStartTo}]`,
          conditions,
        ),
        orderBy: "dateStart desc",
      });
      return { content: [jsonText({ count: sheets.length, timeSheets: sheets.map(toLeanTimeSheet) })] };
    },
  );

  server.tool(
    "cw_get_time_sheet",
    "Get one time sheet (GET /time/sheets/{id}) with its audit trail (who submitted, approved, rejected or reversed it, and each status change) and its time entries, lean: id, timeStart, timeEnd, actualHours, billableOption, charge-to, company, work type and status. Read-only.",
    {
      id: z.number().int().positive().describe("Time sheet ID"),
      includeEntries: z.boolean().optional().describe("Include the sheet's time entries (default: true)"),
    },
    TIME_SHEET_READ_ONLY,
    async ({ id, includeEntries }) => {
      const sheet = await client.get<CwRecord>(`/time/sheets/${id}`);
      const audits = await fetchAllPages<CwRecord>(client, `/time/sheets/${id}/audits`);
      const entries =
        includeEntries === false
          ? undefined
          : await fetchAllPages<CwRecord>(client, "/time/entries", {
              conditions: `timeSheet/id=${id}`,
              orderBy: "timeStart asc",
              fields:
                "id,timeStart,timeEnd,actualHours,billableOption,chargeToType,chargeToId,company/identifier,workType/name,status",
            });
      return {
        content: [
          jsonText({
            timeSheet: toLeanTimeSheet(sheet),
            audits: audits.map((audit) => ({
              id: audit.id ?? null,
              member: asRecord(audit.member)?.identifier ?? null,
              message: audit.message ?? null,
              ...(audit.oldValue === undefined ? {} : { oldValue: audit.oldValue }),
              ...(audit.newValue === undefined ? {} : { newValue: audit.newValue }),
            })),
            ...(entries === undefined
              ? {}
              : {
                  entryCount: entries.length,
                  entries: entries.map((entry) => ({
                    id: entry.id ?? null,
                    timeStart: entry.timeStart ?? null,
                    timeEnd: entry.timeEnd ?? null,
                    actualHours: entry.actualHours ?? null,
                    billableOption: entry.billableOption ?? null,
                    chargeToType: entry.chargeToType ?? null,
                    chargeToId: entry.chargeToId ?? null,
                    company: asRecord(entry.company)?.identifier ?? null,
                    workType: asRecord(entry.workType)?.name ?? null,
                    status: entry.status ?? null,
                  })),
                }),
          }),
        ],
      };
    },
  );

  server.tool(
    "cw_submit_time_sheet",
    "Submit one time sheet for approval (POST /time/sheets/{id}/submit). Only a sheet that is Open or Rejected is submitted. Requires confirm: true. Without it nothing is written and the plan is returned. After the write the sheet is read back: a good submit reads PendingApproval. The submit is recorded against the member whose keys make the call, which may not be the member whose sheet it is. A reverse leaves a sheet Open, so a reversed sheet is submitted again with this tool before it can be approved.",
    {
      id: z.number().int().positive().describe("Time sheet ID"),
      confirm: z.boolean().optional().describe("Must be true for the submit to happen. Omitted or false makes no write"),
    },
    TIME_SHEET_WRITE,
    async ({ id, confirm }) => runSheetAction(client, "submit", { id, confirm }),
  );

  server.tool(
    "cw_approve_time_sheet",
    `Approve one time sheet at tier one (POST /time/sheets/{id}/approve with approvalType ${TIER_ONE_APPROVAL_TYPE}). The approval is recorded against the member whose keys make the call. Only a submitted sheet (PendingApproval or ErrorsCorrected) is approved: submit an Open or Rejected sheet first with cw_submit_time_sheet. Requires confirm: true. Without it nothing is written and the plan is returned. After the write the sheet is read back: a good approval reads ApprovedByTierOne. Approval feeds billing. Tier one only: this tool never sends another approvalType.`,
    {
      id: z.number().int().positive().describe("Time sheet ID"),
      confirm: z.boolean().optional().describe("Must be true for the approval to happen. Omitted or false makes no write"),
    },
    TIME_SHEET_WRITE,
    async ({ id, confirm }) => runSheetAction(client, "approve", { id, confirm }),
  );

  server.tool(
    "cw_reject_time_sheet",
    `Reject one submitted time sheet at tier one (POST /time/sheets/{id}/reject with approvalType ${TIER_ONE_APPROVAL_TYPE}). Only a submitted sheet (PendingApproval or ErrorsCorrected) is rejected. ConnectWise rejects a sheet only after at least one of its time entries is rejected, and the API has no way to reject a time entry (a patch of an entry's status is accepted and ignored). So reject the incorrect time entries in Manage first, then call this tool. A sheet with no rejected entry is refused with reason entries-not-rejected and nothing is changed. Requires confirm: true. Without it nothing is written and the plan is returned. After the write the sheet is read back: a good reject reads Rejected. ConnectWise's reject call takes no reason, so the reason is returned in the result for the caller's record and is not stored on the sheet.`,
    {
      id: z.number().int().positive().describe("Time sheet ID"),
      reason: z
        .string()
        .trim()
        .min(3)
        .optional()
        .describe("Why the sheet is rejected. Returned in the result. ConnectWise does not store it"),
      confirm: z.boolean().optional().describe("Must be true for the reject to happen. Omitted or false makes no write"),
    },
    TIME_SHEET_WRITE,
    async ({ id, reason, confirm }) => runSheetAction(client, "reject", { id, reason, confirm }),
  );

  server.tool(
    "cw_reverse_time_sheet",
    `Reverse a tier one approval on one time sheet (POST /time/sheets/{id}/reverse with approvalType ${TIER_ONE_APPROVAL_TYPE}), so its time entries can be changed again. Only a sheet that reads ApprovedByTierOne is reversed. Requires confirm: true and a reason. Without confirm: true nothing is written and the plan is returned. After the write the sheet is read back. A reverse takes the approval off and un-submits the sheet, so a good reverse reads Open, and the sheet's time entries read Open again. To approve it again, submit it first with cw_submit_time_sheet. ConnectWise's reverse call takes no reason, so the reason is returned in the result and is not stored on the sheet. To change one time entry on an approved sheet and approve the sheet again in one call, use cw_edit_approved_time_entry. To add time to an approved sheet: reverse it, create the entry, submit it and approve it.`,
    {
      id: z.number().int().positive().describe("Time sheet ID"),
      reason: z.string().trim().min(3).describe("Why the approval is reversed. Returned in the result"),
      confirm: z.boolean().optional().describe("Must be true for the reverse to happen. Omitted or false makes no write"),
    },
    TIME_SHEET_WRITE,
    async ({ id, reason, confirm }) => runSheetAction(client, "reverse", { id, reason, confirm }),
  );

  server.tool(
    "cw_edit_approved_time_entry",
    "Change one time entry on a time sheet that is approved at tier one, in four steps, each read back: reverse the sheet (which leaves it Open), patch the time entry, submit the sheet, approve the sheet again. Use it only for an entry whose sheet reads ApprovedByTierOne: for any other entry use cw_update_time_entry. Requires confirm: true and a reason. Without confirm: true nothing is written and the plan is returned with the entry's current values. The result lists every field of the time entry that changed, read before the first step and after the last: field, from and to (shown as a change log shows them: a reference by its name, notes cut at 200 characters), and the raw before and after values. inPlan says whether the field was in the operations. unplannedChanges names every field ConnectWise changed by itself, and plannedNotChanged names every field in the operations that did not change. The time sheet's own changes are listed the same way. If the patch fails, the sheet is still submitted and approved again so it is left as it was found, and the result says so. The submit and both status changes are recorded against the member whose keys make the call. A patch on id, member or timeSheet is refused.",
    {
      timeEntryId: z.number().int().positive().describe("Time entry ID"),
      operations: z
        .array(ticketPatchOperationSchema)
        .min(1)
        .describe("JSON Patch operations for the time entry, for example { op: 'replace', path: 'billableOption', value: 'NoCharge' }"),
      reason: z.string().trim().min(3).describe("Why the entry is changed. Returned in the result"),
      confirm: z.boolean().optional().describe("Must be true for any write to happen. Omitted or false makes no write"),
    },
    TIME_SHEET_WRITE,
    async ({ timeEntryId, operations, reason, confirm }) => {
      const missingValue = operationsMissingValue(operations);
      if (missingValue.length > 0) {
        return {
          content: [{ type: "text", text: `No request was made. add and replace need a value: ${missingValue.join(", ")}.` }],
          isError: true,
        };
      }
      const plannedFields = [...new Set(operations.map((operation) => fieldOfPath(operation.path)))];
      const refused = plannedFields.filter((field) => GUIDED_EDIT_REFUSED_FIELDS.includes(field));
      if (refused.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: `No request was made. This tool does not change ${refused.join(", ")} on a time entry: that would move the entry off its time sheet.`,
            },
          ],
          isError: true,
        };
      }

      const entryPath = `/time/entries/${timeEntryId}`;
      const entryBefore = await client.get<CwRecord>(entryPath);
      const sheetId = idOf(entryBefore.timeSheet);
      if (sheetId === null) {
        return {
          content: [jsonText({ saved: false, message: `Time entry ${timeEntryId} is on no time sheet. Nothing was changed.` })],
          isError: true,
        };
      }
      const sheetPath = `/time/sheets/${sheetId}`;
      const sheetBefore = await client.get<CwRecord>(sheetPath);
      const statusBefore = statusOf(sheetBefore);
      if (statusBefore !== STATUS_APPROVED_TIER_ONE) {
        return {
          content: [
            jsonText({
              saved: false,
              message: `Time sheet ${sheetId} is ${statusBefore ?? "in no status"}, not ApprovedByTierOne, so there is no approval to reverse. Change the entry with cw_update_time_entry. Nothing was changed.`,
              timeSheet: toLeanTimeSheet(sheetBefore),
            }),
          ],
          isError: true,
        };
      }

      const current = Object.fromEntries(
        plannedFields.map((field) => [field, { value: withoutInfo(entryBefore[field]) ?? null, shown: displayValue(field, entryBefore[field]) }]),
      );
      if (confirm !== true) {
        return {
          content: [
            jsonText({
              saved: false,
              message: "No write was made. Pass confirm: true to reverse the sheet, change the entry, submit the sheet and approve it again.",
              timeEntryId,
              reason,
              planned: {
                steps: [
                  `POST /time/sheets/${sheetId}/reverse`,
                  `PATCH /time/entries/${timeEntryId}`,
                  `POST /time/sheets/${sheetId}/submit`,
                  `POST /time/sheets/${sheetId}/approve`,
                ],
                operations,
              },
              current,
              timeSheet: toLeanTimeSheet(sheetBefore),
            }),
          ],
          isError: true,
        };
      }

      const steps: CwRecord[] = [];
      const finish = async (message: string, extra: CwRecord = {}) => {
        // Read both records once more, so the changes come from fresh reads and not from what was sent.
        let entryAfter: CwRecord | null = null;
        let sheetAfter: CwRecord | null = null;
        const unread: string[] = [];
        try {
          entryAfter = await client.get<CwRecord>(entryPath);
        } catch (err: unknown) {
          unread.push(`time entry: ${errorMessage(err)}`);
        }
        try {
          sheetAfter = await client.get<CwRecord>(sheetPath);
        } catch (err: unknown) {
          unread.push(`time sheet: ${errorMessage(err)}`);
        }
        const changes = entryAfter
          ? diffRecords(entryBefore, entryAfter).map((change) => ({ ...change, inPlan: plannedFields.includes(change.field) }))
          : [];
        const changedFields = changes.map((change) => change.field);
        const statusAfter = statusOf(sheetAfter);
        const completed = steps.length === 4 && steps.every((step) => step.ok === true);
        const verified = completed && unread.length === 0 && statusAfter === STATUS_APPROVED_TIER_ONE;
        return {
          content: [
            jsonText({
              completed,
              verified,
              message,
              timeEntryId,
              reason,
              steps,
              changes,
              unplannedChanges: changedFields.filter((field) => !plannedFields.includes(field)),
              plannedNotChanged: entryAfter ? plannedFields.filter((field) => !changedFields.includes(field)) : [],
              timeSheet: {
                id: sheetId,
                statusBefore,
                statusAfter,
                changes: sheetAfter ? diffRecords(sheetBefore, sheetAfter) : [],
              },
              ...(unread.length > 0 ? { unread } : {}),
              ...extra,
            }),
          ],
          isError: !verified,
        };
      };

      // Step 1: reverse the approval.
      const reverse = await changeSheetStatus(client, sheetId, "reverse", statusBefore);
      steps.push({ step: "reverse", ...reverse });
      if (!reverse.ok) {
        return finish("The reverse did not go through, so the time entry was not changed. Read the time sheet status below before any other step.");
      }

      // Step 2: change the entry, and read it back.
      let patchError: string | undefined;
      try {
        await client.patch(entryPath, operations);
      } catch (err: unknown) {
        patchError = errorMessage(err);
      }
      steps.push({ step: "edit", ok: patchError === undefined, ...(patchError ? { error: patchError } : {}) });

      // Steps 3 and 4: submit the sheet and approve it again. These run after a failed patch too,
      // so the sheet is left as it was found.
      const submit = await changeSheetStatus(client, sheetId, "submit", reverse.statusAfter);
      steps.push({ step: "submit", ...submit });
      let restored = false;
      if (submit.ok) {
        const approve = await changeSheetStatus(client, sheetId, "approve", submit.statusAfter);
        steps.push({ step: "approve", ...approve });
        restored = approve.ok;
      }
      const leftAs = submit.ok
        ? "It is left submitted and not approved: read its status below and approve it before billing runs."
        : "It is left reversed and not submitted: read its status below, then submit and approve it before billing runs.";

      if (patchError !== undefined) {
        return finish(
          restored
            ? "The time entry was not changed: ConnectWise refused the patch. The time sheet was submitted and approved again, so it is as it was found."
            : `The time entry was not changed, and the time sheet could NOT be approved again. ${leftAs}`,
        );
      }
      return finish(
        restored
          ? "The time sheet was reversed, the time entry was changed, and the time sheet was submitted and approved again."
          : `The time entry was changed, but the time sheet could NOT be approved again. ${leftAs}`,
      );
    },
  );

  server.tool(
    "cw_list_missing_time_sheets",
    "List the time sheets that are missing at a moment. A sheet is missing when it is Open or Rejected after 10am Perth time on the first business day after its Saturday to Friday period. Business days come from each member's own ConnectWise holiday list (their calendar names the list), with the Western Australia list as the fall back. Active members only. Members to leave out are passed in excludeMembers: none is left out by default. Returns one row per member with each missing period: the sheet id, the period, the status, the hours entered, the due day and the business days overdue (0 on the due day). Read-only.",
    {
      now: z
        .string()
        .regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d$/, "Perth local time as YYYY-MM-DDTHH:mm")
        .optional()
        .describe("The moment to judge, in Perth local time, for example 2026-10-13T11:00. Default: now"),
      excludeMembers: z
        .array(z.string().trim().min(1))
        .optional()
        .describe("Member identifiers to leave out, for example [\"NColyer-Long\"]. Default: none"),
      lookbackWeeks: z
        .number()
        .int()
        .min(1)
        .max(52)
        .optional()
        .describe("How many weeks back to look for periods (default: 6)"),
      dueHourPerth: z.number().int().min(0).max(23).optional().describe("The hour a sheet is due, Perth time (default: 10)"),
    },
    TIME_SHEET_READ_ONLY,
    async ({ now, excludeMembers, lookbackWeeks, dueHourPerth }) => {
      const clock = perthClock(now);
      const weeks = lookbackWeeks ?? 6;
      const from = new Date(clock.getTime() - weeks * 7 * DAY_MS);
      const sheets = await fetchAllPages<CwRecord>(client, "/time/sheets", {
        conditions: `dateStart>=[${ymd(from)}]`,
        orderBy: "dateStart asc",
        fields: "id,member/identifier,member/name,status,hours,dateStart,dateEnd",
      });
      const members = await fetchAllPages<CwRecord>(client, "/system/members", {
        conditions: "inactiveFlag=false",
        fields: "identifier,firstName,lastName,officeEmail,calendar",
      });
      const holidays = await readHolidays(client, members);
      const people = findMissingSheets({
        sheets,
        members,
        holidays,
        now: clock,
        excludeMembers: excludeMembers ?? [],
        dueHourPerth: dueHourPerth ?? 10,
      });
      return {
        content: [
          jsonText({
            asAtPerth: clock.toISOString().slice(0, 16).replace("T", " "),
            dueHourPerth: dueHourPerth ?? 10,
            lookbackWeeks: weeks,
            excludeMembers: excludeMembers ?? [],
            peopleCount: people.length,
            sheetCount: people.reduce((total, person) => total + person.periods.length, 0),
            people,
            holidayLists: Object.fromEntries(Object.entries(holidays.lists).map(([name, dates]) => [name, dates.length])),
            fallBackHolidayList: holidays.waList,
          }),
        ],
      };
    },
  );
}

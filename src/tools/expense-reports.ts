import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient } from "../api-client.js";
import { andConditions, fetchAllPages } from "./paging.js";

/**
 * Expense report tools (ConnectWise Expense API, /expense/reports), built and
 * guarded like the time sheet tools.
 *
 * An expense report is one member's group of expense entries sent for
 * approval. These tools find and read reports for any member, submit them,
 * and approve, reject and reverse them at tier one. Approval feeds billing,
 * so every write needs confirm: true, checks the status first and reads the
 * report and its entries back.
 *
 * What is proven on our instance (12/11 and 17/11/2026): GET works for other
 * members, POST /approve with approvalType Tier1Update reads back
 * ApprovedByTierOne, PATCH and PUT on a report answer 405, and
 * POST /expense/entries/{id}/reject answers 404 (there is no entry reject).
 * Not yet proven on a real report: the reject body (a comment is sent, and a
 * refusal is returned as ConnectWise gave it), the submit call, and what a
 * good reject reads back. A result that does not read back the expected
 * status is reported as not verified, never as done.
 *
 * There is no delete tool and no tool that edits a report or an entry.
 */

const REPORT_READ_ONLY = { readOnlyHint: true };
/** Approving, rejecting or reversing a report changes what bills. */
const REPORT_WRITE = { readOnlyHint: false, destructiveHint: true };

/** The approvalType ConnectWise takes for a tier one decision. Tier one only: no tool takes it from the caller. */
export const EXPENSE_TIER_ONE_APPROVAL_TYPE = "Tier1Update";

const STATUS_APPROVED_TIER_ONE = "ApprovedByTierOne";
const STATUS_REJECTED = "Rejected";
const STATUS_OPEN = "Open";
/** A report that has been submitted and waits for a tier one decision. */
export const SUBMITTED_STATUSES = ["PendingApproval", "ErrorsCorrected"];
/** A report that has not been submitted. */
export const NOT_SUBMITTED_STATUSES = ["Open", "Rejected"];

type CwRecord = Record<string, unknown>;
type ReportAction = "submit" | "approve" | "reject" | "reverse";

const asRecord = (value: unknown): CwRecord | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as CwRecord) : null;

const statusOf = (record: CwRecord | null) => (typeof record?.status === "string" ? record.status : null);

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

const jsonText = (value: unknown) => ({ type: "text" as const, text: JSON.stringify(value, null, 2) });

const fail = (value: unknown) => ({ content: [jsonText(value)], isError: true });

/** The lean shape of an expense report. Fields ConnectWise does not return read as null. */
export function toLeanExpenseReport(report: CwRecord): CwRecord {
  const member = asRecord(report.member);
  const info = asRecord(report._info) ?? {};
  const day = (value: unknown) => (typeof value === "string" ? value.slice(0, 10) : null);
  return {
    id: report.id ?? null,
    name: report.name ?? null,
    member: member
      ? { id: member.id ?? null, identifier: member.identifier ?? null, name: member.name ?? null }
      : null,
    status: report.status ?? null,
    startDate: day(report.startDate),
    endDate: day(report.endDate),
    total: report.total ?? null,
    _info: { lastUpdated: info.lastUpdated ?? null, updatedBy: info.updatedBy ?? null },
  };
}

/** The lean shape of an expense entry on a report. */
export function toLeanReportEntry(entry: CwRecord): CwRecord {
  const type = asRecord(entry.type);
  const company = asRecord(entry.company);
  return {
    id: entry.id ?? null,
    date: typeof entry.date === "string" ? entry.date.slice(0, 10) : null,
    amount: entry.amount ?? null,
    status: entry.status ?? null,
    type: type ? { id: type.id ?? null, name: type.name ?? null } : null,
    notes: entry.notes ?? null,
    billableOption: entry.billableOption ?? null,
    chargeToType: entry.chargeToType ?? null,
    chargeToId: entry.chargeToId ?? null,
    company: company ? { id: company.id ?? null, name: company.name ?? null } : null,
  };
}

async function readEntries(client: CwManageClient, reportId: number): Promise<CwRecord[]> {
  return fetchAllPages<CwRecord>(client, "/expense/entries", {
    conditions: `expenseReport/id=${reportId}`,
    orderBy: "id asc",
  });
}

function countByStatus(entries: CwRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    const key = statusOf(entry) ?? "none";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

const ALLOWED_FROM: Record<ReportAction, string[]> = {
  submit: NOT_SUBMITTED_STATUSES,
  approve: SUBMITTED_STATUSES,
  reject: SUBMITTED_STATUSES,
  // Strict guard: a reverse moved a PendingApproval report back to Open on our instance, so only an approved report goes through.
  reverse: [STATUS_APPROVED_TIER_ONE],
};

const PAST_TENSE: Record<ReportAction, string> = {
  submit: "submitted",
  approve: "approved",
  reject: "rejected",
  reverse: "reversed",
};

/** True when the status read back is one this action should leave. */
function landed(action: ReportAction, statusAfter: string | null): boolean {
  if (action === "submit") return statusAfter !== null && SUBMITTED_STATUSES.includes(statusAfter);
  if (action === "approve") return statusAfter === STATUS_APPROVED_TIER_ONE;
  if (action === "reject") return statusAfter === STATUS_REJECTED;
  return statusAfter === STATUS_OPEN;
}

/** A submit takes no body. The others take the tier one approval type, and a reject also takes the reason as its comment. */
function bodyFor(action: ReportAction, reason?: string): Record<string, unknown> {
  if (action === "submit") return {};
  if (action === "reject") return { approvalType: EXPENSE_TIER_ONE_APPROVAL_TYPE, comment: reason };
  return { approvalType: EXPENSE_TIER_ONE_APPROVAL_TYPE };
}

/** The shared handler for submit, approve, reject and reverse: guard, plan, write, read back. */
export async function runReportAction(
  client: CwManageClient,
  action: ReportAction,
  args: { id: number; reason?: string; confirm?: boolean },
) {
  const before = await client.get<CwRecord>(`/expense/reports/${args.id}`);
  const statusBefore = statusOf(before);
  const report = toLeanExpenseReport(before);
  const reason = args.reason === undefined ? {} : { reason: args.reason };

  if (!statusBefore || !ALLOWED_FROM[action].includes(statusBefore)) {
    return fail({
      saved: false,
      message: `Expense report ${args.id} is ${statusBefore ?? "in no status"}, so it is not ${PAST_TENSE[action]}. This tool takes a report that is ${ALLOWED_FROM[action].join(" or ")}. Nothing was changed.`,
      expenseReport: report,
    });
  }
  if ((action === "reject" || action === "reverse") && !args.reason) {
    return fail({
      saved: false,
      message: `No request to change anything was made. A ${action} needs a reason.`,
      expenseReport: report,
    });
  }

  const entriesBefore = await readEntries(client, args.id);
  const body = bodyFor(action, args.reason);

  if (args.confirm !== true) {
    return fail({
      saved: false,
      message:
        action === "reject"
          ? "No write was made. Pass confirm: true to reject this expense report. The reason is sent to ConnectWise as the reject comment, so the engineer's rejection notice can carry it."
          : `No write was made. Pass confirm: true to ${action} this expense report.`,
      planned: { call: `POST /expense/reports/${args.id}/${action}`, ...body },
      ...reason,
      expenseReport: report,
      entryStatuses: countByStatus(entriesBefore),
      entries: entriesBefore.map(toLeanReportEntry),
    });
  }

  let sendError: string | undefined;
  try {
    await client.post(`/expense/reports/${args.id}/${action}`, body);
  } catch (err: unknown) {
    sendError = errorMessage(err);
  }

  let after: CwRecord | null = null;
  let entriesAfter: CwRecord[] | null = null;
  let readError: string | undefined;
  try {
    after = await client.get<CwRecord>(`/expense/reports/${args.id}`);
    entriesAfter = await readEntries(client, args.id);
  } catch (err: unknown) {
    readError = errorMessage(err);
  }
  const statusAfter = statusOf(after);
  const moved = statusAfter !== null && statusAfter !== statusBefore;
  const verified = sendError === undefined && readError === undefined && landed(action, statusAfter);
  let error: string | undefined;
  if (sendError !== undefined) error = sendError;
  else if (readError !== undefined) error = `The ${action} was sent but the read back failed: ${readError}`;
  else if (!verified) {
    error = `ConnectWise accepted the ${action}, but the report reads ${statusAfter ?? "no status"}.`;
  }
  return {
    content: [
      jsonText({
        saved: error === undefined || moved,
        verified,
        action,
        ...body,
        statusBefore,
        statusAfter,
        ...reason,
        ...(error ? { error } : {}),
        expenseReport: after ? toLeanExpenseReport(after) : report,
        entryStatusesBefore: countByStatus(entriesBefore),
        ...(entriesAfter
          ? { entryStatuses: countByStatus(entriesAfter), entries: entriesAfter.map(toLeanReportEntry) }
          : {}),
      }),
    ],
    isError: !verified,
  };
}

const idField = z.number().int().positive().describe("Expense report ID");
const confirmField = (verb: string) =>
  z.boolean().optional().describe(`Must be true for the ${verb} to happen. Omitted or false makes no write`);

/**
 * Register the expense report tools on the MCP server.
 *
 * @param server MCP server to register tools on.
 * @param client ConnectWise Manage client used by the tools.
 */
export function registerExpenseReportTools(server: McpServer, client: CwManageClient) {
  server.tool(
    "cw_search_expense_reports",
    "Search expense reports for any member (GET /expense/reports). An expense report is one member's group of expense entries sent for approval. Each row is lean: id, name, member, status, startDate, endDate, total and _info.lastUpdated. Filter by member, status or the date the report period starts. Reads all pages, newest first. Status is one of Open, PendingApproval, ErrorsCorrected, Rejected, ApprovedByTierOne, ReadyToBill or Billed. Read-only.",
    {
      memberIdentifier: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9._-]+$/, "Letters, digits, dot, dash and underscore only")
        .optional()
        .describe("Only this member's reports, by member identifier, for example sjenner"),
      memberId: z.number().int().positive().optional().describe("Only this member's reports, by member ID"),
      status: z
        .string()
        .trim()
        .regex(/^[A-Za-z]+$/, "A status name, letters only")
        .optional()
        .describe("Only reports in this status, for example PendingApproval"),
      periodStartFrom: z
        .string()
        .regex(/^\d{4}-\d\d-\d\d$/, "YYYY-MM-DD")
        .optional()
        .describe("Only reports whose period starts on or after this date (YYYY-MM-DD)"),
      periodStartTo: z
        .string()
        .regex(/^\d{4}-\d\d-\d\d$/, "YYYY-MM-DD")
        .optional()
        .describe("Only reports whose period starts on or before this date (YYYY-MM-DD)"),
      conditions: z.string().optional().describe("ConnectWise conditions query string, added to the filters above"),
    },
    REPORT_READ_ONLY,
    async ({ memberIdentifier, memberId, status, periodStartFrom, periodStartTo, conditions }) => {
      const reports = await fetchAllPages<CwRecord>(client, "/expense/reports", {
        conditions: andConditions(
          memberIdentifier === undefined ? undefined : `member/identifier='${memberIdentifier}'`,
          memberId === undefined ? undefined : `member/id=${memberId}`,
          status === undefined ? undefined : `status='${status}'`,
          periodStartFrom === undefined ? undefined : `startDate>=[${periodStartFrom}]`,
          periodStartTo === undefined ? undefined : `startDate<=[${periodStartTo}]`,
          conditions,
        ),
        orderBy: "id desc",
      });
      return { content: [jsonText({ count: reports.length, expenseReports: reports.map(toLeanExpenseReport) })] };
    },
  );

  server.tool(
    "cw_get_expense_report",
    "Get one expense report (GET /expense/reports/{id}) with its expense entries, lean: id, date, amount, status, type, notes, billableOption, charge-to and company, and a count of the entries by status. Works for any member's report. Read-only.",
    {
      id: idField,
      includeEntries: z.boolean().optional().describe("Include the report's expense entries (default: true)"),
    },
    REPORT_READ_ONLY,
    async ({ id, includeEntries }) => {
      const report = await client.get<CwRecord>(`/expense/reports/${id}`);
      const entries = includeEntries === false ? undefined : await readEntries(client, id);
      return {
        content: [
          jsonText({
            expenseReport: toLeanExpenseReport(report),
            ...(entries === undefined
              ? {}
              : { entryCount: entries.length, entryStatuses: countByStatus(entries), entries: entries.map(toLeanReportEntry) }),
          }),
        ],
      };
    },
  );

  server.tool(
    "cw_approve_expense_report",
    `Approve one expense report at tier one (POST /expense/reports/{id}/approve with approvalType ${EXPENSE_TIER_ONE_APPROVAL_TYPE}). The approval is recorded against the member whose keys make the call. Only a submitted report (PendingApproval or ErrorsCorrected) is approved. Requires confirm: true. Without it nothing is written and the plan is returned with the report's entries. After the write the report and its entries are read back: a good approval reads ApprovedByTierOne. Approval feeds billing. Tier one only: this tool never sends another approvalType.`,
    { id: idField, confirm: confirmField("approval") },
    REPORT_WRITE,
    async ({ id, confirm }) => runReportAction(client, "approve", { id, confirm }),
  );

  server.tool(
    "cw_reject_expense_report",
    `Reject one expense report at tier one (POST /expense/reports/{id}/reject with approvalType ${EXPENSE_TIER_ONE_APPROVAL_TYPE} and the reason as comment), so the engineer gets the rejection notice. Needs a reason. Only a submitted report (PendingApproval or ErrorsCorrected) is rejected. There is no entry reject in ConnectWise: expense entries cannot be rejected one at a time. Requires confirm: true. Without it nothing is written and the plan is returned with the report's entries. After the write the report and every entry are read back, with entry counts by status before and after, because a reject may move entries as well. A good reject reads Rejected. If ConnectWise refuses the comment, its refusal is returned and nothing is changed. Whether the reason reaches the engineer in the notice is checked on the first live reject.`,
    {
      id: idField,
      reason: z.string().trim().min(3).describe("Why the report is rejected, and what the engineer is to fix. Sent as the reject comment"),
      confirm: confirmField("reject"),
    },
    REPORT_WRITE,
    async ({ id, reason, confirm }) => runReportAction(client, "reject", { id, reason, confirm }),
  );

  server.tool(
    "cw_submit_expense_report",
    "Submit one expense report for approval (POST /expense/reports/{id}/submit, empty body), for example to put a rejected report back to PendingApproval. Only a report that is Open or Rejected is submitted. Requires confirm: true. Without it nothing is written and the plan is returned. After the write the report and its entries are read back: a good submit reads PendingApproval, or ErrorsCorrected for a report that was Rejected. The submit is recorded against the member whose keys make the call.",
    { id: idField, confirm: confirmField("submit") },
    REPORT_WRITE,
    async ({ id, confirm }) => runReportAction(client, "submit", { id, confirm }),
  );

  server.tool(
    "cw_reverse_expense_report",
    `Reverse a tier one approval on one expense report (POST /expense/reports/{id}/reverse with approvalType ${EXPENSE_TIER_ONE_APPROVAL_TYPE}). Only a report that reads ApprovedByTierOne is reversed: any other status is refused before ConnectWise is called, because on our instance a reverse moved a PendingApproval report back to Open. Requires confirm: true and a reason. Without confirm: true nothing is written and the plan is returned. After the write the report and its entries are read back: a good reverse reads Open. The reason is returned in the result and is not stored on the report.`,
    {
      id: idField,
      reason: z.string().trim().min(3).describe("Why the approval is reversed. Returned in the result"),
      confirm: confirmField("reverse"),
    },
    REPORT_WRITE,
    async ({ id, reason, confirm }) => runReportAction(client, "reverse", { id, reason, confirm }),
  );
}

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwApiError, CwManageClient, hasApiStatus } from "../api-client.js";

/** How a time entry bills, as ConnectWise's TimeEntry.billableOption accepts it. */
export const BILLABLE_OPTIONS = ["Billable", "DoNotBill", "NoCharge", "NoDefault"] as const;

/** ConnectWise's refusal of an entry on a submitted or past period. */
const TIME_PERIOD_NOT_OPEN = /time period.{0,20}not open/i;
/** A closed ticket refusing time, should ConnectWise answer a 400 for it. */
const TICKET_CLOSED = /ticket.{0,40}\bclosed\b/i;

export function registerTimeEntryTools(server: McpServer, client: CwManageClient) {
  server.tool(
    "cw_search_time_entries",
    "Search time entries in ConnectWise Manage.",
    {
      conditions: z.string().optional().describe("ConnectWise conditions query string (e.g. \"member/identifier = 'jsmith'\")"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
      orderBy: z.string().optional().describe("Field to order by"),
    },
    async ({ conditions, page, pageSize, orderBy }) => {
      const result = await client.get("/time/entries", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_get_time_entry",
    "Get a specific time entry by ID.",
    {
      id: z.number().describe("Time entry ID"),
    },
    async ({ id }) => {
      const result = await client.get(`/time/entries/${id}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_create_time_entry",
    "Create a new time entry. Requires confirm: true. Without it nothing is written and the planned body is returned. billableOption sets how the time bills (Billable, DoNotBill, NoCharge or NoDefault) at creation, so no patch is needed afterwards. A ticket that is closed refuses new time: the tool reports that and does not reopen the ticket. An entry on a time period that is submitted or past is refused with \"time period not open\" unless the member's time sheet is passed as timeSheetId (the sheet's ID for that period). When billableOption or timeSheetId is set, the entry is read back and the response carries a verified block.",
    {
      chargeToType: z.enum(["ServiceTicket", "ProjectTicket", "ChargeCode", "Activity"]).describe("What to charge the time to"),
      chargeToId: z.number().describe("ID of the ticket, charge code, or activity"),
      memberId: z.number().describe("Member ID for the time entry"),
      timeStart: z.string().describe("Start time (ISO 8601)"),
      timeEnd: z.string().optional().describe("End time (ISO 8601)"),
      actualHours: z.number().optional().describe("Actual hours worked (alternative to timeEnd)"),
      notes: z.string().optional().describe("Work notes"),
      internalNotes: z.string().optional().describe("Internal-only notes"),
      workTypeId: z.number().optional().describe("Work type ID"),
      workRoleId: z.number().optional().describe("Work role ID"),
      billableOption: z
        .enum(BILLABLE_OPTIONS)
        .optional()
        .describe("How the time bills: Billable, DoNotBill, NoCharge or NoDefault. Omit to let ConnectWise decide"),
      timeSheetId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Time sheet ID for the period the entry falls in. Needed to add time to a submitted or past period"),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true for the entry to be created. Omitted or false makes no write"),
    },
    async ({
      chargeToType,
      chargeToId,
      memberId,
      timeStart,
      timeEnd,
      actualHours,
      notes,
      internalNotes,
      workTypeId,
      workRoleId,
      billableOption,
      timeSheetId,
      confirm,
    }) => {
      const body: Record<string, unknown> = {
        chargeToType,
        chargeToId,
        member: { id: memberId },
        timeStart,
      };
      if (timeEnd) body.timeEnd = timeEnd;
      if (actualHours !== undefined) body.actualHours = actualHours;
      if (notes) body.notes = notes;
      if (internalNotes) body.internalNotes = internalNotes;
      if (workTypeId) body.workType = { id: workTypeId };
      if (workRoleId) body.workRole = { id: workRoleId };
      if (billableOption) body.billableOption = billableOption;
      if (timeSheetId !== undefined) body.timeSheet = { id: timeSheetId };

      const fail = (reason: string, message: string, extra: Record<string, unknown> = {}) => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ saved: false, reason, message, chargeToType, chargeToId, ...extra }, null, 2),
          },
        ],
        isError: true,
      });

      // A closed ticket refuses new time. Say so before the write, and never reopen it.
      const ticketPath =
        chargeToType === "ServiceTicket"
          ? `/service/tickets/${chargeToId}`
          : chargeToType === "ProjectTicket"
            ? `/project/tickets/${chargeToId}`
            : undefined;
      if (ticketPath) {
        try {
          const ticket = await client.get<{ closedFlag?: boolean }>(ticketPath);
          if (ticket?.closedFlag === true) {
            return fail(
              "ticket-closed",
              `Ticket ${chargeToId} is closed, so ConnectWise does not take new time on it. No time was added and the ticket was not reopened.`,
            );
          }
        } catch (err: unknown) {
          if (hasApiStatus(err, 404)) {
            return fail("ticket-not-found", `Ticket ${chargeToId} was not found. No time was added.`);
          }
          throw err;
        }
      }

      if (confirm !== true) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  saved: false,
                  message: "No write was made. Pass confirm: true to create this time entry.",
                  planned: body,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      let result: Record<string, unknown>;
      try {
        result = await client.post<Record<string, unknown>>("/time/entries", body);
      } catch (err: unknown) {
        if (err instanceof CwApiError && err.status === 400) {
          if (TIME_PERIOD_NOT_OPEN.test(err.message)) {
            return fail(
              "time-period-not-open",
              timeSheetId === undefined
                ? "ConnectWise refused the entry because its time period is not open (the period is submitted or past). Pass timeSheetId, the member's time sheet for that period, and try again. Nothing was added."
                : "ConnectWise refused the entry because its time period is not open, even with the time sheet passed. Check that timeSheetId is the member's sheet for the period of timeStart. Nothing was added.",
            );
          }
          if (TICKET_CLOSED.test(err.message)) {
            return fail(
              "ticket-closed",
              `ConnectWise refused the entry because the ticket is closed. No time was added and the ticket was not reopened.`,
            );
          }
        }
        throw err;
      }

      // Without a new option, the entry is returned as ConnectWise created it.
      if (billableOption === undefined && timeSheetId === undefined) {
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      const id = typeof result?.id === "number" ? result.id : undefined;
      if (id === undefined) {
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      const fresh = await client.get<Record<string, unknown>>(`/time/entries/${id}`);
      const verified: Record<string, boolean> = {};
      if (billableOption !== undefined) verified.billableOption = fresh.billableOption === billableOption;
      if (timeSheetId !== undefined) {
        verified.timeSheet = (fresh.timeSheet as { id?: number } | null | undefined)?.id === timeSheetId;
      }
      const ok = Object.values(verified).every(Boolean);
      return {
        content: [{ type: "text", text: JSON.stringify({ ...fresh, verified }, null, 2) }],
        isError: !ok,
      };
    },
  );

  server.tool(
    "cw_update_time_entry",
    "Update a time entry with JSON Patch (Manage PATCH /time/entries/{id}). Use this to correct a mistaken entry, including actualHours on a metered agreement (those hours round to 0.25). Paths are field names such as actualHours, notes, internalNotes, timeStart, timeEnd, or billableOption. Billed entries may be rejected by Manage.",
    {
      id: z.number().describe("Time entry ID"),
      operations: z
        .array(
          z.object({
            op: z.enum(["replace", "add", "remove"]).describe("Patch operation"),
            path: z.string().describe("Field path (e.g. 'actualHours', 'notes', 'timeEnd')"),
            value: z.unknown().optional().describe("New value"),
          }),
        )
        .describe("JSON Patch operations applied to the time entry"),
    },
    async ({ id, operations }) => {
      const result = await client.patch(`/time/entries/${id}`, operations);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_delete_time_entry",
    "Delete a time entry (Manage DELETE /time/entries/{id}). Use this to remove a mistaken entry before it is billed. Manage rejects deletes of entries that are already billed.",
    {
      id: z.number().describe("Time entry ID"),
    },
    async ({ id }) => {
      await client.delete(`/time/entries/${id}`);
      return {
        content: [{ type: "text", text: JSON.stringify({ id, deleted: true }, null, 2) }],
      };
    },
  );
}

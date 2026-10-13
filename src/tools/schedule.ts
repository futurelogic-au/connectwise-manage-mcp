import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient, hasApiStatus } from "../api-client.js";

/**
 * Schedule entries book a member's time against a ticket, activity or project.
 * They are distinct from time entries: a schedule entry is the forward booking,
 * a time entry is the record of work done. Schedule entries also sync to the
 * member's Outlook calendar, so booking here avoids double entry in Outlook.
 *
 * Timezone: ConnectWise stores and returns dateStart / dateEnd in UTC, marked
 * with a trailing "Z". Perth (AWST) is UTC+8 with no daylight saving, so a
 * 10:00 Perth booking is sent as 02:00Z on the same date. A Perth time before
 * 08:00 falls on the previous UTC date.
 */

const UTC_NOTE =
  "ConnectWise interprets dateStart and dateEnd as UTC (trailing 'Z'). Perth (AWST) is UTC+8 with no daylight saving, so 10:00 Perth is 02:00Z and a Perth time before 08:00 lands on the previous UTC date.";

const SCHEDULE_READ_ONLY = { readOnlyHint: true };
/** Creating a booking only adds an entry. */
const SCHEDULE_ADDITIVE_WRITE = { readOnlyHint: false, destructiveHint: false };
/** Updating a booking overwrites fields on an existing entry. */
const SCHEDULE_WRITE = { readOnlyHint: false, destructiveHint: true };

// Same rule as cw_update_agreement_addition and cw_update_contact: z.unknown()
// accepts a missing key, so add/replace must explicitly require a value.
// RFC 6902 forbids a patch that omits it. Remove may omit value.
const requiredScheduleValue = z.unknown().refine((value) => value !== undefined, {
  message: "value is required for add/replace operations (RFC 6902)",
});

const schedulePath = z
  .string()
  .describe("JSON path (e.g. 'dateStart', 'dateEnd', 'status/id', 'member/id', 'doneFlag')");

const schedulePatchOperation = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add"),
    path: schedulePath,
    value: requiredScheduleValue.describe("New value"),
  }),
  z.object({
    op: z.literal("replace"),
    path: schedulePath,
    value: requiredScheduleValue.describe("New value"),
  }),
  z.object({
    op: z.literal("remove"),
    path: schedulePath,
    value: z.unknown().optional().describe("Unused for remove"),
  }),
]);

/** Perth (AWST) is UTC+8 with no daylight saving, so a Perth time is UTC plus eight hours. */
export function formatPerth(iso: string): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return iso;
  const perth = new Date(instant.getTime() + 8 * 60 * 60 * 1000);
  const two = (n: number) => String(n).padStart(2, "0");
  return (
    `${two(perth.getUTCDate())}/${two(perth.getUTCMonth() + 1)}/${perth.getUTCFullYear()} ` +
    `${two(perth.getUTCHours())}:${two(perth.getUTCMinutes())}`
  );
}

interface NamedRef {
  id?: number;
  name?: string;
  identifier?: string;
}

/** The linked ticket a schedule entry books against, by its schedule type. */
export function linkedTicketPath(entry: { objectId?: unknown; type?: NamedRef | null }): {
  kind: "service" | "project";
  id: number;
  notesPath: string;
} | null {
  if (typeof entry.objectId !== "number") return null;
  const identifier = entry.type?.identifier?.toUpperCase();
  const name = entry.type?.name?.toLowerCase();
  if (identifier === "S" || name === "service") {
    return { kind: "service", id: entry.objectId, notesPath: `/service/tickets/${entry.objectId}/notes` };
  }
  if (identifier === "P" || name === "project") {
    return { kind: "project", id: entry.objectId, notesPath: `/project/tickets/${entry.objectId}/notes` };
  }
  return null;
}

/**
 * Register the schedule entry tools (search, list types and statuses, create,
 * JSON Patch update, and a guarded delete) on the MCP server.
 *
 * @param server MCP server to register tools on.
 * @param client ConnectWise Manage client used by the tools.
 */
export function registerScheduleTools(server: McpServer, client: CwManageClient) {
  server.tool(
    "cw_search_schedule_entries",
    "Search schedule entries (booked resource time) in ConnectWise Manage. Use 'conditions' for CW query syntax (e.g. \"member/id = 147 and type/id = 4\"). Each entry carries objectId (the ticket, activity or project ticket it is booked against), member, dateStart, dateEnd, type, status, reminder, doneFlag and hours. " +
      UTC_NOTE,
    {
      conditions: z
        .string()
        .optional()
        .describe(
          "ConnectWise conditions query string (e.g. \"member/id = 147 and dateStart >= [2026-09-22T00:00:00Z]\"). Date literals go in square brackets and are UTC.",
        ),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z
        .number()
        .optional()
        .describe("Results per page (default: 25, max: 1000)"),
      orderBy: z
        .string()
        .optional()
        .describe("Field to order by (e.g. 'dateStart asc')"),
    },
    SCHEDULE_READ_ONLY,
    async ({ conditions, page, pageSize, orderBy }) => {
      const result = await client.get("/schedule/entries", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_list_schedule_types",
    "List schedule types in ConnectWise Manage. The type decides what kind of object the entry books against, so call this before creating an entry. Typical identifiers are 'S' for Service (a service ticket), 'P' for Project, 'C' for Sales and 'N' for Meeting.",
    {
      conditions: z.string().optional().describe("ConnectWise conditions query string"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
    },
    SCHEDULE_READ_ONLY,
    async ({ conditions, page, pageSize }) => {
      const result = await client.get("/schedule/types", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_list_schedule_statuses",
    "List schedule statuses in ConnectWise Manage. Statuses are usually 'Tentative' and 'Firm', one of which is flagged as the instance default.",
    {
      conditions: z.string().optional().describe("ConnectWise conditions query string"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
    },
    SCHEDULE_READ_ONLY,
    async ({ conditions, page, pageSize }) => {
      const result = await client.get("/schedule/statuses", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_create_schedule_entry",
    "Book resource time by creating a schedule entry against a ticket, activity or project ticket. This is the forward booking, not the record of work done: use cw_create_time_entry for that. The entry syncs to the member's Outlook calendar, so there is no need to book the same work in Outlook separately. memberId is required and never assumed, so confirm who the booking is for before calling. " +
      UTC_NOTE,
    {
      objectId: z
        .number()
        .describe(
          "ID of the object being booked against: the service ticket ID for a Service type entry, the project ticket ID for a Project type entry, or the activity ID for a Sales type entry",
        ),
      typeId: z
        .number()
        .describe(
          "Schedule type ID from cw_list_schedule_types. Use the 'S' (Service) type for a service ticket",
        ),
      memberId: z
        .number()
        .describe(
          "Member ID the time is booked for. Required and never defaulted: confirm the member before booking",
        ),
      dateStart: z
        .string()
        .describe(
          "Start of the booking in UTC ISO 8601 (e.g. '2026-09-22T02:00:00Z' is 10:00 Perth time)",
        ),
      dateEnd: z
        .string()
        .describe(
          "End of the booking in UTC ISO 8601 (e.g. '2026-09-22T03:00:00Z' is 11:00 Perth time)",
        ),
      statusId: z
        .number()
        .optional()
        .describe(
          "Schedule status ID from cw_list_schedule_statuses (e.g. Tentative or Firm). Defaults to the instance default status",
        ),
      reminderId: z
        .number()
        .optional()
        .describe(
          "Reminder lead time ID, as carried on existing entries (commonly 1 = 0 minutes, 2 = 5 minutes, 4 = 15 minutes). ConnectWise exposes no list endpoint for these, so read one off an existing entry with cw_search_schedule_entries",
        ),
      whereId: z
        .number()
        .optional()
        .describe(
          "Service location ID for where the work happens (e.g. On-Site, In-house, Remote)",
        ),
      spanId: z
        .number()
        .optional()
        .describe(
          "Schedule span ID, which controls whether the entry spans working hours or a full day",
        ),
      name: z
        .string()
        .optional()
        .describe(
          "Entry name. ConnectWise generates one from the linked object when omitted",
        ),
      hours: z
        .number()
        .optional()
        .describe(
          "Booked hours. ConnectWise derives this from dateStart and dateEnd when omitted",
        ),
      doneFlag: z
        .boolean()
        .optional()
        .describe("Mark the booking as done (default: false)"),
      ownerFlag: z
        .boolean()
        .optional()
        .describe("Mark the member as the owner of the entry"),
      acknowledgedFlag: z
        .boolean()
        .optional()
        .describe("Mark the entry as acknowledged by the member"),
      allowScheduleConflictsFlag: z
        .boolean()
        .optional()
        .describe(
          "Allow the booking even where it overlaps an existing entry for the member (default: false)",
        ),
    },
    SCHEDULE_ADDITIVE_WRITE,
    async ({
      objectId,
      typeId,
      memberId,
      dateStart,
      dateEnd,
      statusId,
      reminderId,
      whereId,
      spanId,
      name,
      hours,
      doneFlag,
      ownerFlag,
      acknowledgedFlag,
      allowScheduleConflictsFlag,
    }) => {
      const body: Record<string, unknown> = {
        objectId,
        type: { id: typeId },
        member: { id: memberId },
        dateStart,
        dateEnd,
      };
      if (statusId) body.status = { id: statusId };
      if (reminderId) body.reminder = { id: reminderId };
      if (whereId) body.where = { id: whereId };
      if (spanId) body.span = { id: spanId };
      if (name) body.name = name;
      if (hours !== undefined) body.hours = hours;
      if (doneFlag !== undefined) body.doneFlag = doneFlag;
      if (ownerFlag !== undefined) body.ownerFlag = ownerFlag;
      if (acknowledgedFlag !== undefined) body.acknowledgedFlag = acknowledgedFlag;
      if (allowScheduleConflictsFlag !== undefined) {
        body.allowScheduleConflictsFlag = allowScheduleConflictsFlag;
      }

      const result = await client.post("/schedule/entries", body);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_update_schedule_entry",
    "Update an existing schedule entry using JSON Patch operations. Use this to move a booking, change its status, or mark it done. To remove a wrong booking use cw_delete_schedule_entry, which only deletes a future entry that is not done and leaves a note on the ticket. " +
      UTC_NOTE,
    {
      id: z.number().describe("Schedule entry ID"),
      operations: z.array(schedulePatchOperation).describe("Array of JSON Patch operations"),
    },
    SCHEDULE_WRITE,
    async ({ id, operations }) => {
      const result = await client.patch(`/schedule/entries/${id}`, operations);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_delete_schedule_entry",
    "Delete a wrong booking (Manage DELETE /schedule/entries/{id}). Only a future schedule entry that is not done is deleted. A done entry, an entry that has started, or an entry with time logged against it is refused, and so is an entry that is not booked against a service ticket or a project ticket, because the delete is recorded as an internal note on that ticket. Requires confirm: true and a reason. Without confirm: true nothing is written and the plan is returned. After the delete the tool adds an internal note to the linked ticket naming the member, the original date and time in Perth time, and the reason, then reads the entry and the note back.",
    {
      id: z.number().int().positive().describe("Schedule entry ID"),
      reason: z
        .string()
        .trim()
        .min(3)
        .describe("Why the booking is being deleted. Written into the ticket note"),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true for the delete to happen. Omitted or false makes no write"),
    },
    SCHEDULE_WRITE,
    async ({ id, reason, confirm }) => {
      const entryPath = `/schedule/entries/${id}`;
      const refuse = (why: string, extra: Record<string, unknown> = {}) => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ deleted: false, refused: true, id, message: why, ...extra }, null, 2),
          },
        ],
        isError: true,
      });

      let entry: Record<string, unknown>;
      try {
        entry = await client.get<Record<string, unknown>>(entryPath);
      } catch (err: unknown) {
        if (hasApiStatus(err, 404)) return refuse(`Schedule entry ${id} was not found. Nothing was changed.`);
        throw err;
      }

      const member = entry.member as NamedRef | undefined;
      const dateStart = typeof entry.dateStart === "string" ? entry.dateStart : undefined;
      const dateEnd = typeof entry.dateEnd === "string" ? entry.dateEnd : undefined;
      const linked = linkedTicketPath(entry as { objectId?: unknown; type?: NamedRef | null });
      const entryType = entry.type as NamedRef | null | undefined;
      const summary = {
        id,
        member: member ? { id: member.id ?? null, name: member.name ?? null } : null,
        dateStart: dateStart ?? null,
        dateEnd: dateEnd ?? null,
        objectId: typeof entry.objectId === "number" ? entry.objectId : null,
        // The type's name, else the ticket kind it resolves to, else its identifier. A type
        // that carries only an identifier used to show as null.
        type: entryType?.name ?? linked?.kind ?? entryType?.identifier ?? null,
      };

      // D9: future, not-done entries only.
      if (entry.doneFlag === true) {
        return refuse(`Schedule entry ${id} is marked done, so it is not deleted. Nothing was changed.`, { entry: summary });
      }
      const startMs = dateStart ? Date.parse(dateStart) : NaN;
      if (Number.isNaN(startMs)) {
        return refuse(`Schedule entry ${id} has no start date, so it cannot be judged as a future booking. Nothing was changed.`, { entry: summary });
      }
      if (startMs <= Date.now()) {
        return refuse(
          `Schedule entry ${id} started at ${formatPerth(dateStart!)} Perth time, which is not in the future, so it is not deleted. Nothing was changed.`,
          { entry: summary },
        );
      }

      // The delete is recorded on the linked ticket, so there has to be one.
      if (!linked) {
        return refuse(
          `Schedule entry ${id} is not booked against a service ticket or a project ticket, so there is no ticket to carry the note. Nothing was changed.`,
          { entry: summary },
        );
      }

      // Time against it: a time entry for the same member on the same ticket inside the booking.
      if (member?.id !== undefined && dateEnd) {
        const timeEntries = await client.get<Array<{ id?: number }>>("/time/entries", {
          conditions: `chargeToId = ${linked.id} and member/id = ${member.id} and timeStart >= [${dateStart}] and timeStart <= [${dateEnd}]`,
          pageSize: 5,
        });
        if (Array.isArray(timeEntries) && timeEntries.length > 0) {
          return refuse(
            `Schedule entry ${id} has time logged against it (time entry ${timeEntries.map((t) => t.id).join(", ")}), so it is not deleted. Nothing was changed.`,
            { entry: summary, timeEntryIds: timeEntries.map((t) => t.id ?? null) },
          );
        }
      }

      const who = member?.name ? `${member.name}${member.identifier ? ` (${member.identifier})` : ""}` : `member ${member?.id ?? "unknown"}`;
      const noteText =
        `Schedule entry ${id} was deleted. Member: ${who}. ` +
        `Was booked: ${formatPerth(dateStart!)} to ${dateEnd ? formatPerth(dateEnd) : "unknown"} Perth time (AWST). ` +
        `Reason: ${reason}`;

      if (confirm !== true) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  deleted: false,
                  message: "No write was made. Pass confirm: true to delete this booking.",
                  entry: summary,
                  note: { ticketKind: linked.kind, ticketId: linked.id, text: noteText },
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      await client.delete(entryPath);

      // The entry is gone. Add the note, then read both back.
      let noteId: number | null = null;
      let noteError: string | undefined;
      try {
        const created = await client.post<Record<string, unknown>>(linked.notesPath, {
          text: noteText,
          internalAnalysisFlag: true,
        });
        noteId = typeof created?.id === "number" ? created.id : null;
      } catch (err: unknown) {
        noteError = err instanceof Error ? err.message : String(err);
      }

      let entryGone = false;
      try {
        await client.get(entryPath);
      } catch (err: unknown) {
        entryGone = hasApiStatus(err, 404);
      }

      let noteReadBack = false;
      if (noteId !== null) {
        try {
          const notes = await client.get<Array<{ id?: number }>>(linked.notesPath, {
            pageSize: 10,
            orderBy: "id desc",
          });
          noteReadBack = Array.isArray(notes) && notes.some((n) => n.id === noteId);
        } catch {
          /* reported as not read back */
        }
      }

      const ok = entryGone && noteId !== null && noteReadBack;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                deleted: true,
                verified: ok,
                entryGone,
                entry: summary,
                note: {
                  added: noteId !== null,
                  id: noteId,
                  readBack: noteReadBack,
                  ticketKind: linked.kind,
                  ticketId: linked.id,
                  text: noteText,
                  ...(noteError ? { error: noteError } : {}),
                },
                ...(noteId === null
                  ? {
                      warning:
                        "The booking was deleted but the ticket note was not added. Add the note text above to the ticket by hand.",
                    }
                  : {}),
              },
              null,
              2,
            ),
          },
        ],
        isError: !ok,
      };
    },
  );
}

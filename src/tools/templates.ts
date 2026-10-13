import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient, hasApiStatus } from "../api-client.js";
import { andConditions, fetchAllPages } from "./paging.js";
import {
  checkPatchAgainstRecord,
  operationsMissingValue,
  ticketPatchOperationSchema,
} from "./ticket-lean.js";

/**
 * Service ticket template tools (ConnectWise Service API, /service/templates).
 *
 * A service template is the record behind a recurring ticket. ConnectWise
 * stamps what a template makes with enteredBy "template" plus the template id:
 * the ticket it generates, and the schedule entry of type "SR Template" it
 * books ahead of the ticket. That stamp is how a ticket or a booking is traced
 * back to its template.
 *
 * The API does not return a template's recurrence (how often it runs, or when
 * it ends), so no tool here can stop a template recurring and leave the record
 * in place. The way to stop one is to retire it: delete it with the retire
 * flag. No tool here calls /service/templates/{id}/generate.
 */

const TEMPLATE_READ_ONLY = { readOnlyHint: true };
/** Updating or deleting a template changes what ConnectWise generates. */
const TEMPLATE_WRITE = { readOnlyHint: false, destructiveHint: true };

/** Schedule type 12, "SR Template": a booking a template made ahead of its ticket. */
const SR_TEMPLATE_SCHEDULE_TYPE = 12;

/** D16: a template that generated a ticket inside this many days is not deleted. */
export const TEMPLATE_DELETE_GUARD_DAYS = 90;

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

function ref(value: unknown): { id: number | null; name: string | null } | null {
  const record = asRecord(value);
  if (!record) return null;
  return {
    id: typeof record.id === "number" ? record.id : null,
    name:
      typeof record.name === "string"
        ? record.name
        : typeof record.identifier === "string"
          ? record.identifier
          : null,
  };
}

/** The lean shape of a service template. */
export function toLeanTemplate(template: CwRecord): CwRecord {
  const info = asRecord(template._info) ?? {};
  return {
    id: template.id ?? null,
    name: template.name ?? null,
    summary: template.summary ?? null,
    board: ref(template.board),
    status: ref(template.status),
    company: ref(template.company),
    team: ref(template.team),
    type: ref(template.type),
    assignedBy: ref(template.assignedBy),
    templateFlag: template.templateFlag ?? null,
    scheduleDaysBefore: template.scheduleDaysBefore ?? null,
    serviceDaysBefore: template.serviceDaysBefore ?? null,
    _info: { lastUpdated: info.lastUpdated ?? null, updatedBy: info.updatedBy ?? null },
  };
}

/**
 * Read the template id out of an enteredBy stamp. ConnectWise writes
 * "template562" for a record template 562 made. Anything else is not a stamp.
 */
export function templateIdFromEnteredBy(enteredBy: unknown): number | null {
  if (typeof enteredBy !== "string") return null;
  const match = /^template(\d+)$/i.exec(enteredBy.trim());
  return match ? Number(match[1]) : null;
}

/** The ISO time this many days before now, to the second, as ConnectWise conditions take it. */
export function daysAgoIso(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

interface TemplateUsage {
  recentTicketCount: number;
  recentTickets: CwRecord[];
  /** Tickets the template made that are still open, whenever it made them. */
  openTickets: CwRecord[];
  pendingBookings: CwRecord[];
}

/**
 * What a template has made: the tickets it generated inside the guard window,
 * the tickets it made that are still open, and its bookings that are not done.
 */
async function readTemplateUsage(client: CwManageClient, id: number, now: Date): Promise<TemplateUsage> {
  const since = daysAgoIso(TEMPLATE_DELETE_GUARD_DAYS, now);
  const tickets = await fetchAllPages<CwRecord>(client, "/service/tickets", {
    conditions: `enteredBy='template${id}' and dateEntered>=[${since}]`,
    orderBy: "id desc",
    fields: "id,summary,closedFlag,_info/dateEntered",
  });
  const open = await fetchAllPages<CwRecord>(client, "/service/tickets", {
    conditions: `enteredBy='template${id}' and closedFlag=false`,
    orderBy: "id desc",
    fields: "id,summary,status/name,owner/identifier,_info/dateEntered",
  });
  const bookings = await fetchAllPages<CwRecord>(client, "/schedule/entries", {
    conditions: `type/id=${SR_TEMPLATE_SCHEDULE_TYPE} and objectId=${id} and doneFlag=false`,
    orderBy: "dateStart asc",
    fields: "id,name,member/identifier,dateStart,dateEnd,doneFlag",
  });
  return {
    recentTicketCount: tickets.length,
    recentTickets: tickets.slice(0, 10).map((ticket) => ({
      id: ticket.id ?? null,
      summary: ticket.summary ?? null,
      closedFlag: ticket.closedFlag ?? null,
      dateEntered: asRecord(ticket._info)?.dateEntered ?? null,
    })),
    openTickets: open.map((ticket) => ({
      id: ticket.id ?? null,
      summary: ticket.summary ?? null,
      status: asRecord(ticket.status)?.name ?? null,
      owner: asRecord(ticket.owner)?.identifier ?? null,
      dateEntered: asRecord(ticket._info)?.dateEntered ?? null,
    })),
    pendingBookings: bookings.map((booking) => ({
      id: booking.id ?? null,
      name: booking.name ?? null,
      member: asRecord(booking.member)?.identifier ?? null,
      dateStart: booking.dateStart ?? null,
      dateEnd: booking.dateEnd ?? null,
    })),
  };
}

function refuse(message: string, extra: CwRecord = {}) {
  return { content: [jsonText({ saved: false, message, ...extra })], isError: true };
}

/**
 * Register the service template tools on the MCP server.
 *
 * @param server MCP server to register tools on.
 * @param client ConnectWise Manage client used by the tools.
 */
export function registerTemplateTools(server: McpServer, client: CwManageClient) {
  server.tool(
    "cw_list_service_templates",
    "List service ticket templates, the records behind recurring tickets (GET /service/templates). Each row is lean: id, name, summary, board, status, company, team, type, assignedBy, templateFlag, scheduleDaysBefore, serviceDaysBefore and _info.lastUpdated. Filter by company, board or part of the name. Reads all pages. The API does not return a template's recurrence. Read-only.",
    {
      companyId: z.number().int().positive().optional().describe("Only templates for this company"),
      boardId: z.number().int().positive().optional().describe("Only templates on this service board"),
      nameContains: z
        .string()
        .trim()
        .min(1)
        .regex(/^[^'"*]+$/, "Must not contain a quote mark or *")
        .optional()
        .describe("Only templates whose name contains this text"),
      conditions: z.string().optional().describe("ConnectWise conditions query string, added to the filters above"),
    },
    TEMPLATE_READ_ONLY,
    async ({ companyId, boardId, nameContains, conditions }) => {
      const templates = await fetchAllPages<CwRecord>(client, "/service/templates", {
        conditions: andConditions(
          companyId === undefined ? undefined : `company/id=${companyId}`,
          boardId === undefined ? undefined : `board/id=${boardId}`,
          nameContains === undefined ? undefined : `name contains '${nameContains}'`,
          conditions,
        ),
        orderBy: "id asc",
      });
      return { content: [jsonText({ count: templates.length, templates: templates.map(toLeanTemplate) })] };
    },
  );

  server.tool(
    "cw_get_service_template",
    `Get one service ticket template as the full record (GET /service/templates/{id}), with what it has made: the tickets it generated in the last ${TEMPLATE_DELETE_GUARD_DAYS} days, the tickets it made that are still open, and the bookings it has made that are not done yet. The API does not return a template's recurrence. Read-only.`,
    { id: z.number().int().positive().describe("Service template ID") },
    TEMPLATE_READ_ONLY,
    async ({ id }) => {
      const template = await client.get<CwRecord>(`/service/templates/${id}`);
      const usage = await readTemplateUsage(client, id, new Date());
      return { content: [jsonText({ template, usage })] };
    },
  );

  server.tool(
    "cw_trace_template_source",
    'Find the template that generated a service ticket or a schedule entry. Pass exactly one of ticketId and scheduleEntryId. ConnectWise stamps a generated record with enteredBy "template" plus the template id, and that stamp is read here. Returns the template, lean, or says plainly that the record was not made by a template and who entered it. A template that has since been deleted is reported with its id and found: false. Read-only.',
    {
      ticketId: z.number().int().positive().optional().describe("Service ticket ID"),
      scheduleEntryId: z.number().int().positive().optional().describe("Schedule entry ID"),
    },
    TEMPLATE_READ_ONLY,
    async ({ ticketId, scheduleEntryId }) => {
      if ((ticketId === undefined) === (scheduleEntryId === undefined)) {
        return {
          content: [{ type: "text", text: "No request was made. Pass exactly one of ticketId and scheduleEntryId." }],
          isError: true,
        };
      }

      let source: CwRecord;
      let enteredBy: unknown;
      if (ticketId !== undefined) {
        const ticket = await client.get<CwRecord>(`/service/tickets/${ticketId}`);
        enteredBy = asRecord(ticket._info)?.enteredBy;
        source = {
          kind: "ticket",
          id: ticketId,
          summary: ticket.summary ?? null,
          company: ref(ticket.company),
          board: ref(ticket.board),
          enteredBy: enteredBy ?? null,
          dateEntered: asRecord(ticket._info)?.dateEntered ?? null,
        };
      } else {
        const entry = await client.get<CwRecord>(`/schedule/entries/${scheduleEntryId}`);
        enteredBy = asRecord(entry._info)?.enteredBy;
        source = {
          kind: "scheduleEntry",
          id: scheduleEntryId,
          name: entry.name ?? null,
          type: ref(entry.type),
          objectId: entry.objectId ?? null,
          dateStart: entry.dateStart ?? null,
          enteredBy: enteredBy ?? null,
          dateEntered: asRecord(entry._info)?.dateEntered ?? null,
        };
      }

      const templateId = templateIdFromEnteredBy(enteredBy);
      if (templateId === null) {
        return {
          content: [
            jsonText({
              source,
              generatedByTemplate: false,
              message: `This record was not made by a template. It was entered by ${typeof enteredBy === "string" && enteredBy ? enteredBy : "an unknown member"}.`,
            }),
          ],
        };
      }

      try {
        const template = await client.get<CwRecord>(`/service/templates/${templateId}`);
        return {
          content: [
            jsonText({ source, generatedByTemplate: true, templateId, found: true, template: toLeanTemplate(template) }),
          ],
        };
      } catch (err: unknown) {
        if (!hasApiStatus(err, 404)) throw err;
        return {
          content: [
            jsonText({
              source,
              generatedByTemplate: true,
              templateId,
              found: false,
              message: `The record was made by template ${templateId}, and that template no longer exists.`,
            }),
          ],
        };
      }
    },
  );

  server.tool(
    "cw_update_service_template",
    "Update one service ticket template using JSON Patch operations (PATCH /service/templates/{id}). Requires confirm: true. Without it nothing is written and the planned change is returned with the template's current values. After the write the template is read back and the response reports whether the fresh read holds the values that were sent. The change applies to tickets the template generates from now on, not to tickets it has already made. This tool does not change a template's recurrence, which the API does not return: to stop a template recurring, retire it with cw_delete_service_template.",
    {
      id: z.number().int().positive().describe("Service template ID"),
      operations: z
        .array(ticketPatchOperationSchema)
        .min(1)
        .describe("JSON Patch operations, for example { op: 'replace', path: 'summary', value: '...' }"),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true for any write to happen. Omitted or false makes no write"),
    },
    TEMPLATE_WRITE,
    async ({ id, operations, confirm }) => {
      const missingValue = operationsMissingValue(operations);
      if (missingValue.length > 0) {
        return {
          content: [{ type: "text", text: `No request was made. add and replace need a value: ${missingValue.join(", ")}.` }],
          isError: true,
        };
      }
      const touchesId = operations.filter((operation) => /^\/?id$/i.test(operation.path.trim()));
      if (touchesId.length > 0) {
        return {
          content: [{ type: "text", text: "No request was made. A template's id cannot be changed." }],
          isError: true,
        };
      }

      const path = `/service/templates/${id}`;
      const before = await client.get<CwRecord>(path);
      if (confirm !== true) {
        return refuse("No write was made. Pass confirm: true to apply this change.", {
          planned: operations,
          template: toLeanTemplate(before),
        });
      }

      await client.patch(path, operations);
      let fresh: CwRecord;
      try {
        fresh = await client.get<CwRecord>(path);
      } catch (err: unknown) {
        return {
          content: [
            jsonText({
              saved: true,
              verified: false,
              error: `The patch was saved but the read back failed: ${errorMessage(err)}`,
            }),
          ],
          isError: true,
        };
      }
      const check = checkPatchAgainstRecord(fresh, operations);
      const verified = check.mismatches.length === 0;
      return {
        content: [
          jsonText({
            saved: true,
            verified,
            ...(check.mismatches.length > 0 ? { mismatches: check.mismatches } : {}),
            ...(check.unchecked.length > 0 ? { unchecked: check.unchecked } : {}),
            template: toLeanTemplate(fresh),
          }),
        ],
        isError: !verified,
      };
    },
  );

  server.tool(
    "cw_delete_service_template",
    `Delete one service ticket template (DELETE /service/templates/{id}). Requires confirm: true, a reason, and noteTicketId: the service ticket where the delete is recorded as an internal note. A template that generated a ticket in the last ${TEMPLATE_DELETE_GUARD_DAYS} days is refused, and so is a template with a booking that is not done yet, unless retire: true is passed. Retire is the way to stop an active template recurring, because the API holds no recurrence to end: with retire: true, confirm: true and a reason, an active template is deleted. The plan always lists the template's forward work: the tickets it made that are still open and its bookings that are not done. Without confirm: true nothing is written and the plan is returned. After the delete the tool adds the internal note naming the template and the reason, then reads the template back (expecting it gone) and the note back. The tool never closes a ticket or removes a booking: after a retire it returns them in followUp, and each one is shown to the user before any write.`,
    {
      id: z.number().int().positive().describe("Service template ID"),
      reason: z.string().trim().min(3).describe("Why the template is being deleted. Written into the ticket note"),
      noteTicketId: z
        .number()
        .int()
        .positive()
        .describe("Service ticket that gets the internal note recording the delete"),
      retire: z
        .boolean()
        .optional()
        .describe(
          `Must be true to delete a template that generated a ticket in the last ${TEMPLATE_DELETE_GUARD_DAYS} days or has a booking that is not done. Omitted or false keeps that guard`,
        ),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true for the delete to happen. Omitted or false makes no write"),
    },
    TEMPLATE_WRITE,
    async ({ id, reason, noteTicketId, retire, confirm }) => {
      const path = `/service/templates/${id}`;
      const template = await client.get<CwRecord>(path);
      const lean = toLeanTemplate(template);
      const usage = await readTemplateUsage(client, id, new Date());

      const forward = { openTickets: usage.openTickets, pendingBookings: usage.pendingBookings };
      const active = usage.recentTicketCount > 0 || usage.pendingBookings.length > 0;
      if (active && retire !== true) {
        const why =
          usage.recentTicketCount > 0
            ? `generated ${usage.recentTicketCount} ticket(s) in the last ${TEMPLATE_DELETE_GUARD_DAYS} days`
            : `has ${usage.pendingBookings.length} booking(s) that are not done yet`;
        return refuse(
          `Template ${id} ${why}, so it is not deleted. Nothing was changed. To stop an active template, pass retire: true.`,
          {
            deleted: false,
            reason: usage.recentTicketCount > 0 ? "recent-tickets" : "pending-bookings",
            template: lean,
            recentTickets: usage.recentTickets,
            forward,
          },
        );
      }

      // Read the note ticket before the delete, so the note has somewhere to go.
      const notesPath = `/service/tickets/${noteTicketId}/notes`;
      const noteTicket = await client.get<CwRecord>(`/service/tickets/${noteTicketId}`);
      const company = ref(template.company);
      const board = ref(template.board);
      const noteText =
        `Service template ${id} was deleted. Name: ${String(template.name ?? "")}. ` +
        `Company: ${company?.name ?? "none"}. Board: ${board?.name ?? "none"}. ` +
        (active
          ? `Retired while active: ${usage.recentTicketCount} ticket(s) generated in the last ${TEMPLATE_DELETE_GUARD_DAYS} days, ` +
            `${usage.openTickets.length} ticket(s) still open, ${usage.pendingBookings.length} booking(s) not done. `
          : "") +
        `Reason: ${reason}`;
      const note = { ticketId: noteTicketId, ticketSummary: noteTicket.summary ?? null, text: noteText };

      if (confirm !== true) {
        return refuse("No write was made. Pass confirm: true to delete this template.", {
          deleted: false,
          retire: active,
          template: lean,
          forward,
          note,
        });
      }

      await client.delete(path);

      // The template is gone. Add the note, then read both back.
      let noteId: number | null = null;
      let noteError: string | undefined;
      try {
        const created = await client.post<CwRecord>(notesPath, { text: noteText, internalAnalysisFlag: true });
        noteId = typeof created?.id === "number" ? created.id : null;
      } catch (err: unknown) {
        noteError = errorMessage(err);
      }

      let templateGone = false;
      try {
        await client.get(path);
      } catch (err: unknown) {
        templateGone = hasApiStatus(err, 404);
      }

      let noteReadBack = false;
      if (noteId !== null) {
        try {
          const notes = await client.get<Array<{ id?: number }>>(notesPath, { pageSize: 10, orderBy: "id desc" });
          noteReadBack = Array.isArray(notes) && notes.some((entry) => entry.id === noteId);
        } catch {
          /* reported as not read back */
        }
      }

      const verified = templateGone && noteId !== null && noteReadBack;
      return {
        content: [
          jsonText({
            deleted: true,
            retired: active,
            verified,
            templateGone,
            template: lean,
            followUp: {
              message:
                usage.openTickets.length + usage.pendingBookings.length === 0
                  ? "The template left no open ticket and no booking that is not done."
                  : "This tool closed no ticket and removed no booking. Show each one below to the user before any write.",
              ticketsToClose: usage.openTickets,
              bookingsToRemove: usage.pendingBookings,
            },
            note: {
              ...note,
              added: noteId !== null,
              id: noteId,
              readBack: noteReadBack,
              ...(noteError ? { error: noteError } : {}),
            },
            ...(noteId === null
              ? {
                  warning:
                    "The template was deleted but the ticket note was not added. Add the note text above to the ticket by hand.",
                }
              : {}),
          }),
        ],
        isError: !verified,
      };
    },
  );
}

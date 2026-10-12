import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient, hasApiStatus } from "../api-client.js";
import { buildTicketCard, TICKET_CARD_META } from "../card.builder.js";
import {
  buildTicketNoteBody,
  mapCreatedNoteResponse,
  planNoteEmail,
  wantsNoteEmail,
  type TicketEmailOverride,
} from "./note-payload.js";
import {
  checkPatchAgainstRecord,
  operationsMissingValue,
  ticketPatchOperationSchema,
  toLeanTicket,
} from "./ticket-lean.js";

/** Most tickets one cw_bulk_update_tickets call will change. Calls run in sequence. */
const BULK_TICKET_LIMIT = 25;

/** Updating tickets overwrites fields on existing records. */
const TICKET_WRITE = { readOnlyHint: false, destructiveHint: true };

const LEAN_DESCRIPTION =
  "Set lean: true to return only id, summary, board, status, owner, company and _info.lastUpdated.";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function jsonText(value: unknown) {
  return { type: "text" as const, text: JSON.stringify(value, null, 2) };
}

export function registerTicketTools(server: McpServer, client: CwManageClient) {
  server.tool(
    "cw_get_ticket_configurations",
    "Get configuration references associated with a service ticket, one page at a time (default: page 1, 25 results). Request additional pages as needed. Returns id, deviceIdentifier, and _info when provided by Manage; use cw_get_configuration for full configuration details.",
    {
      id: z.number().int().positive().describe("Service ticket ID"),
      page: z.number().int().positive().optional().describe("Page number (default: 1)"),
      pageSize: z.number().int().positive().max(1000).optional().describe("Results per page (default: 25, max: 1000)"),
      conditions: z.string().optional().describe("ConnectWise conditions query string"),
      orderBy: z.string().optional().describe("Field to order by (e.g. 'id asc')"),
    },
    async ({ id, page, pageSize, conditions, orderBy }) => {
      const result = await client.get(`/service/tickets/${id}/configurations`, {
        page: page ?? 1,
        pageSize: pageSize ?? 25,
        conditions,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_update_ticket_configurations",
    "Add or remove configuration associations on a service ticket. Operations run sequentially in the supplied order, including repeated configuration IDs. Removing an association leaves the configuration object intact. Continues after individual failures without rollback or automatic retries; returns every operation's outcome and sets isError if any fail. Duplicate-add and missing-association errors are reported as failures.",
    {
      id: z.number().int().positive().describe("Service ticket ID"),
      operations: z.array(z.object({
        action: z.enum(["add", "remove"]).describe("Add or remove the ticket association"),
        configurationId: z.number().int().positive().describe("Existing configuration object ID"),
      })).min(1).describe("Nonempty ordered list of configuration association changes"),
    },
    async ({ id, operations }) => {
      const results = [];
      const path = `/service/tickets/${id}/configurations`;
      for (const operation of operations) {
        try {
          if (operation.action === "add") {
            const configuration = await client.post(path, { id: operation.configurationId });
            results.push({ ...operation, success: true, configuration });
          } else {
            await client.delete(`${path}/${operation.configurationId}`);
            results.push({ ...operation, success: true });
          }
        } catch (err: unknown) {
          results.push({
            ...operation,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const success = results.every((result) => result.success);
      return {
        content: [{ type: "text", text: JSON.stringify({ ticketId: id, success, results }, null, 2) }],
        isError: !success,
      };
    },
  );

  server.tool(
    "cw_search_tickets",
    "Search service tickets in ConnectWise Manage. Use 'conditions' for CW query syntax (e.g. \"status/name != 'Closed'\" or \"company/name = 'Acme'\").",
    {
      conditions: z
        .string()
        .optional()
        .describe("ConnectWise conditions query string"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z
        .number()
        .optional()
        .describe("Results per page (default: 25, max: 1000)"),
      orderBy: z
        .string()
        .optional()
        .describe("Field to order by (e.g. 'id desc')"),
    },
    async ({ conditions, page, pageSize, orderBy }) => {
      const result = await client.get("/service/tickets", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "cw_get_ticket",
    {
      description: `Get a specific service ticket by ID. ${LEAN_DESCRIPTION} A lean response carries no ticket card and is far smaller than the full record.`,
      inputSchema: {
        id: z.number().describe("Ticket ID"),
        lean: z
          .boolean()
          .optional()
          .describe("true returns the lean shape (id, summary, board, status, owner, company, _info.lastUpdated). Default: the full record"),
      },
      // MCP Apps (SEP-1865): renders as an interactive ticket card in App hosts.
      _meta: TICKET_CARD_META,
    },
    async ({ id, lean }) => {
      const result = await client.get<Record<string, unknown>>(`/service/tickets/${id}`);
      if (lean === true) {
        // Lean is opt-in (D13). The lean record goes in the text as well as in
        // structuredContent, so a host that reads only one of them gets the data.
        const leanTicket = toLeanTicket(result);
        return {
          content: [jsonText(leanTicket)],
          structuredContent: leanTicket as unknown as Record<string, unknown>,
        };
      }
      // MCP Apps: attach the normalized card payload the ui:// ticket card
      // renders from. Best-effort — a null card just means no UI surface.
      const card = await buildTicketCard(result, client);
      const structuredContent = card ? { ...result, _card: card } : result;
      const summary = card
        ? `Ticket #${card.id}: ${card.summary} (${card.priority ?? "no priority"}, ${card.status ?? "no status"})`
        : `Ticket #${id}`;
      return {
        content: [{ type: "text", text: summary }],
        structuredContent,
      };
    },
  );

  server.tool(
    "cw_create_ticket",
    "Create a new service ticket.",
    {
      summary: z.string().describe("Ticket summary/title"),
      boardId: z.number().optional().describe("Service board ID"),
      companyId: z.number().optional().describe("Company ID to associate"),
      contactId: z.number().optional().describe("Contact ID to associate"),
      statusId: z.number().optional().describe("Status ID"),
      priorityId: z.number().optional().describe("Priority ID"),
      typeId: z.number().optional().describe("Type ID"),
      subTypeId: z.number().optional().describe("SubType ID"),
      initialDescription: z.string().optional().describe("Initial ticket description"),
      parentTicketId: z
        .number()
        .optional()
        .describe(
          "Parent ticket id (Manage Ticket.parentTicketId). When set, the new ticket is created as a child of this ticket. Omit to leave it unparented. Same field cw_get_ticket returns.",
        ),
    },
    async ({ summary, boardId, companyId, contactId, statusId, priorityId, typeId, subTypeId, initialDescription, parentTicketId }) => {
      const body: Record<string, unknown> = { summary };
      if (boardId) body.board = { id: boardId };
      if (companyId) body.company = { id: companyId };
      if (contactId) body.contact = { id: contactId };
      if (statusId) body.status = { id: statusId };
      if (priorityId) body.priority = { id: priorityId };
      if (typeId) body.type = { id: typeId };
      if (subTypeId) body.subType = { id: subTypeId };
      if (initialDescription) body.initialDescription = initialDescription;
      if (parentTicketId !== undefined) body.parentTicketId = parentTicketId;

      const result = await client.post("/service/tickets", body);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_update_ticket",
    `Update an existing service ticket using JSON Patch operations. ${LEAN_DESCRIPTION} Without lean the response is the full saved ticket, which is large.`,
    {
      id: z.number().describe("Ticket ID"),
      operations: z.array(ticketPatchOperationSchema).describe("Array of JSON Patch operations"),
      lean: z
        .boolean()
        .optional()
        .describe("true returns the lean shape (id, summary, board, status, owner, company, _info.lastUpdated). Default: the full saved ticket"),
    },
    async ({ id, operations, lean }) => {
      const result = await client.patch(`/service/tickets/${id}`, operations);
      const shown = lean === true ? toLeanTicket(result) : result;
      return { content: [jsonText(shown)] };
    },
  );

  server.tool(
    "cw_bulk_update_tickets",
    `Apply one JSON Patch to a list of service tickets, for example to change the owner or status of several tickets at once. Requires confirm: true. Without it nothing is written and the planned change is returned. Tickets are updated one after another, at most ${BULK_TICKET_LIMIT} per call. One failure does not stop the rest: every ticket gets one row, either a lean success row or an error row. After each patch the ticket is read back and the row reports whether the fresh read holds the values that were sent. An optional note is added to each ticket as an internal note (never emailed) after its patch succeeds. Every row is lean: id, summary, board, status, owner, company and _info.lastUpdated.`,
    {
      ids: z
        .array(z.number().int().positive())
        .min(1)
        .max(BULK_TICKET_LIMIT)
        .refine((ids) => new Set(ids).size === ids.length, "ids must not repeat a ticket")
        .describe(`Service ticket IDs, 1 to ${BULK_TICKET_LIMIT}, no repeats`),
      operations: z
        .array(ticketPatchOperationSchema)
        .min(1)
        .describe("JSON Patch operations applied to every ticket in ids"),
      note: z
        .string()
        .min(1)
        .optional()
        .describe("Optional internal note added to each ticket after its patch succeeds. Never emailed"),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true for any write to happen. Omitted or false makes no write"),
    },
    TICKET_WRITE,
    async ({ ids, operations, note, confirm }) => {
      const missingValue = operationsMissingValue(operations);
      if (missingValue.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: `No request was made. add and replace need a value: ${missingValue.join(", ")}.`,
            },
          ],
          isError: true,
        };
      }

      if (confirm !== true) {
        return {
          content: [
            jsonText({
              saved: false,
              message: "No write was made. Pass confirm: true to apply this change.",
              ticketCount: ids.length,
              ids,
              planned: operations,
              ...(note === undefined ? {} : { note }),
            }),
          ],
          isError: true,
        };
      }

      const rows: Array<Record<string, unknown>> = [];
      for (const id of ids) {
        const path = `/service/tickets/${id}`;
        try {
          await client.patch(path, operations);
        } catch (err: unknown) {
          rows.push({ id, success: false, error: errorMessage(err) });
          continue;
        }

        // Read the ticket back so the row reports what ConnectWise now holds,
        // not what was sent.
        let fresh: unknown;
        try {
          fresh = await client.get<Record<string, unknown>>(path);
        } catch (err: unknown) {
          rows.push({
            id,
            success: true,
            verified: false,
            error: `The patch was saved but the read back failed: ${errorMessage(err)}`,
          });
          continue;
        }
        const check = checkPatchAgainstRecord(fresh, operations);
        const row: Record<string, unknown> = {
          id,
          success: true,
          verified: check.mismatches.length === 0,
          ...(check.mismatches.length > 0 ? { mismatches: check.mismatches } : {}),
          ...(check.unchecked.length > 0 ? { unchecked: check.unchecked } : {}),
          ticket: toLeanTicket(fresh),
        };

        if (note !== undefined) {
          try {
            const created = await client.post<Record<string, unknown>>(
              `${path}/notes`,
              buildTicketNoteBody({ text: note, internalAnalysisFlag: true }),
            );
            row.note = { added: true, id: typeof created?.id === "number" ? created.id : null };
          } catch (err: unknown) {
            row.note = { added: false, error: errorMessage(err) };
          }
        }
        rows.push(row);
      }

      const failed = rows.filter(
        (row) =>
          row.success !== true ||
          row.verified === false ||
          (row.note as { added?: boolean } | undefined)?.added === false,
      ).length;
      return {
        content: [
          jsonText({
            requested: ids.length,
            succeeded: rows.filter((row) => row.success === true).length,
            failed,
            rows,
          }),
        ],
        isError: failed > 0,
      };
    },
  );

  server.tool(
    "cw_get_ticket_notes",
    "Get all notes/discussions on a service ticket, including notes from any child tickets.",
    {
      id: z.number().describe("Ticket ID"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
    },
    async ({ id, page, pageSize }) => {
      try {
        const result = await client.get(`/service/tickets/${id}/allNotes`, {
          page: page ?? 1,
          pageSize: pageSize ?? 25,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        if (hasApiStatus(err, 404, 405)) {
          // allNotes not supported on this CWM version — fall back to /notes
          const result = await client.get(`/service/tickets/${id}/notes`, {
            page: page ?? 1,
            pageSize: pageSize ?? 25,
          });
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        throw err;
      }
    },
  );

  server.registerTool(
    "cw_add_ticket_note",
    {
      description:
        "Add a note to a service ticket. Use detailDescriptionFlag for a discussion note, internalAnalysisFlag for an internal-only note, or resolutionFlag for a resolution note. Defaults to a plain discussion note. Email is off unless you set a flag: emailContactFlag emails the ticket contact, emailResourceFlag emails resources, and emailCcFlag emails the addresses in emailCc. Omitting them does not email anyone. This ConnectWise version refuses recipient fields on a note, so a note that emails works through the ticket: the tool holds the matching automaticEmailContactFlag, automaticEmailResourceFlag, automaticEmailCcFlag and automaticEmailCc on the ticket for this one note, posts the note with processNotifications true, then puts the ticket's values back and reads them to check. A recipient you do not name is off for that note. Any note that will email needs confirm: true; without it nothing is written and the plan is returned. Every response carries an email block with a sent indicator. ConnectWise does not report delivery, so sent means the note was posted with mail requested. An explicit processNotifications false suppresses delivery even if a flag is true.",
      inputSchema: {
        id: z.number().describe("Ticket ID"),
        text: z.string().describe("Note text content"),
        detailDescriptionFlag: z.boolean().optional().describe("Add as detail description (default: false)"),
        internalAnalysisFlag: z.boolean().optional().describe("Mark as internal analysis only (default: false)"),
        resolutionFlag: z.boolean().optional().describe("Mark as resolution note (default: false)"),
        customerUpdatedFlag: z.boolean().optional().describe("Flag that the customer was updated (default: false)"),
        emailContactFlag: z
          .boolean()
          .optional()
          .describe("Email the ticket contact. Omit to not email the contact. Never defaults to true."),
        emailResourceFlag: z
          .boolean()
          .optional()
          .describe("Email ticket resources. Omit to not email resources. Never defaults to true."),
        emailCcFlag: z
          .boolean()
          .optional()
          .describe("Email the addresses in emailCc. Omit to not email CC. Never defaults to true. emailCc alone does not send mail."),
        emailCc: z
          .string()
          .optional()
          .describe("CC email addresses. Sent only when provided. Does not email anyone unless emailCcFlag is true."),
        processNotifications: z
          .boolean()
          .optional()
          .describe("Manage ServiceNote processNotifications. Omit unless you need to force notification processing on or off. True sends using the ticket automaticEmail* settings. False suppresses delivery."),
        confirm: z
          .boolean()
          .optional()
          .describe("Must be true when the note will email anyone. Not needed for a note that sends no mail"),
      },
      // MCP Apps (SEP-1865): the ticket card's "Add note" round-trip target.
      _meta: TICKET_CARD_META,
    },
    async ({
      id,
      text,
      detailDescriptionFlag,
      internalAnalysisFlag,
      resolutionFlag,
      customerUpdatedFlag,
      emailContactFlag,
      emailResourceFlag,
      emailCcFlag,
      emailCc,
      processNotifications,
      confirm,
    }) => {
      const input = {
        text,
        detailDescriptionFlag,
        internalAnalysisFlag,
        resolutionFlag,
        customerUpdatedFlag,
        emailContactFlag,
        emailResourceFlag,
        emailCcFlag,
        emailCc,
        processNotifications,
      };
      const body = buildTicketNoteBody(input);
      const ticketPath = `/service/tickets/${id}`;
      const visibility = { detailDescriptionFlag, internalAnalysisFlag, resolutionFlag };

      // A note that asks for no mail is one POST, as it always was.
      const mailMayBeSent =
        processNotifications !== false && (wantsNoteEmail(input) || processNotifications === true);
      if (!mailMayBeSent) {
        const result = await client.post<Record<string, unknown>>(`${ticketPath}/notes`, body);
        const reason =
          processNotifications === false
            ? "processNotifications was set to false, so ConnectWise sends nothing"
            : "no recipient flag was set to true";
        return {
          content: [
            jsonText({
              ...mapCreatedNoteResponse(result, visibility),
              email: { sent: false, via: "none", reason },
            }),
          ],
        };
      }

      // The ticket's own recipient fields decide who is mailed, so read them first.
      const ticket = await client.get<Record<string, unknown>>(ticketPath);
      const plan = planNoteEmail(input, ticket);

      if (plan.problems.length > 0) {
        return {
          content: [
            jsonText({
              saved: false,
              message: `No write was made. ${plan.problems.join("; ")}.`,
              ticketId: id,
            }),
          ],
          isError: true,
        };
      }

      if (plan.willSend && confirm !== true) {
        return {
          content: [
            jsonText({
              saved: false,
              message: "No write was made. This note will email. Pass confirm: true to send it.",
              ticketId: id,
              planned: { via: plan.via, recipients: plan.recipients },
            }),
          ],
          isError: true,
        };
      }

      // Hold the recipient fields on the ticket for this note, then put them back.
      const patched: TicketEmailOverride[] = [];
      let created: Record<string, unknown> | undefined;
      let postError: unknown;
      try {
        if (plan.willSend && plan.overrides.length > 0) {
          await client.patch(
            ticketPath,
            plan.overrides.map((o) => ({ op: "replace", path: o.field, value: o.value })),
          );
          patched.push(...plan.overrides);
        }
        created = await client.post<Record<string, unknown>>(`${ticketPath}/notes`, body);
      } catch (err: unknown) {
        postError = err;
      }

      let restored: boolean | null = null;
      let restoreError: string | undefined;
      if (patched.length > 0) {
        try {
          // A field the ticket did not carry goes back to its empty value.
          const back = (o: TicketEmailOverride) =>
            o.original ?? (typeof o.value === "boolean" ? false : "");
          await client.patch(
            ticketPath,
            patched.map((o) => ({ op: "replace", path: o.field, value: back(o) })),
          );
          const after = await client.get<Record<string, unknown>>(ticketPath);
          restored = patched.every((o) => (after[o.field] ?? back(o)) === back(o));
        } catch (err: unknown) {
          restored = false;
          restoreError = errorMessage(err);
        }
      }

      const original = patched.map((o) => ({ field: o.field, original: o.original }));
      if (postError !== undefined || created === undefined) {
        return {
          content: [
            jsonText({
              saved: false,
              message: `The note was not added: ${errorMessage(postError)}`,
              ticketId: id,
              email: { sent: false, via: plan.via, reason: "the note was not saved" },
              ...(restored === false
                ? {
                    warning:
                      "The ticket's email fields may still hold the values set for this note. Put them back by hand.",
                    original,
                    ...(restoreError ? { restoreError } : {}),
                  }
                : {}),
            }),
          ],
          isError: true,
        };
      }

      const email = plan.willSend
        ? {
            sent: true,
            via: plan.via,
            recipients: plan.recipients,
            deliveryReported: false,
            ...(restored === null ? {} : { ticketFieldsRestored: restored }),
          }
        : { sent: false, via: plan.via, reason: plan.reason };
      const mapped = mapCreatedNoteResponse(created, visibility);
      return {
        content: [
          jsonText({
            ...mapped,
            email,
            ...(restored === false
              ? {
                  warning:
                    "The note was added, but the ticket's email fields could not be confirmed back to their old values. Check them.",
                  original,
                  ...(restoreError ? { restoreError } : {}),
                }
              : {}),
          }),
        ],
        isError: restored === false,
      };
    },
  );
}

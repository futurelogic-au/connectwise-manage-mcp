import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient, hasApiStatus } from "../api-client.js";
import { fetchAllPages } from "./paging.js";
import {
  findInactiveCompany,
  inactiveCompanyMessage,
  isInactiveCompanyError,
} from "./ticket-company.js";

/**
 * cw_merge_tickets (ruling D11): mirror the ConnectWise UI merge.
 *
 * The UI merge closes each merged ticket with a closed status and brings its
 * notes, time and attachments onto the parent. The API does it as
 * POST /service/tickets/{parentId}/merge with { mergeTicketIds, status: { id } }.
 * The tool adds an internal note on the parent listing what was merged.
 *
 * The status the merged tickets are closed with is never hard-coded. It is read
 * live from the children's board. If the board has exactly one closed status it
 * is used. Otherwise the tool stops and lists the statuses, and the caller
 * passes statusId.
 */

const MERGE_LIMIT = 25;
const MERGE_WRITE = { readOnlyHint: false, destructiveHint: true };

interface Ref {
  id?: number;
  name?: string;
  identifier?: string;
}

interface TicketRecord {
  id?: number;
  summary?: string;
  closedFlag?: boolean;
  board?: Ref | null;
  status?: Ref | null;
  company?: Ref | null;
}

interface BoardStatus {
  id?: number;
  name?: string;
  inactive?: boolean;
  closedStatus?: boolean;
}

function row(ticket: TicketRecord) {
  return {
    id: ticket.id ?? null,
    summary: ticket.summary ?? null,
    board: ticket.board ? { id: ticket.board.id ?? null, name: ticket.board.name ?? null } : null,
    status: ticket.status ? { id: ticket.status.id ?? null, name: ticket.status.name ?? null } : null,
    company: ticket.company ? { id: ticket.company.id ?? null, name: ticket.company.name ?? null } : null,
    closed: ticket.closedFlag === true,
  };
}

function text(value: unknown) {
  return { type: "text" as const, text: JSON.stringify(value, null, 2) };
}

export function registerTicketMergeTools(server: McpServer, client: CwManageClient) {
  server.tool(
    "cw_merge_tickets",
    `Merge service tickets into a parent ticket, as the ConnectWise merge does: each child is closed with a closed status and its content moves onto the parent. At most ${MERGE_LIMIT} children. Requires confirm: true. Without it nothing is written and the plan is returned. The parent and every child must be open and belong to the same company. The closed status comes from the children's board, read live: one closed status is used, and where the board has none or several the tool stops and lists them so you can pass statusId. After the merge it adds an internal note on the parent listing what was merged and reads the parent and every child back. To bundle tickets as parent and child without closing them, use cw_create_ticket with parentTicketId instead.`,
    {
      parentId: z.number().int().positive().describe("The ticket that stays open and receives the others"),
      childIds: z
        .array(z.number().int().positive())
        .min(1)
        .max(MERGE_LIMIT)
        .refine((ids) => new Set(ids).size === ids.length, "childIds must not repeat a ticket")
        .describe(`Tickets to merge into the parent, 1 to ${MERGE_LIMIT}, no repeats`),
      statusId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Closed status to give the merged tickets, from cw_list_statuses. Needed only where the board does not have exactly one closed status"),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true for the merge to happen. Omitted or false makes no write"),
    },
    MERGE_WRITE,
    async ({ parentId, childIds, statusId, confirm }) => {
      const refuse = (message: string, extra: Record<string, unknown> = {}) => ({
        content: [text({ merged: false, refused: true, message, parentId, childIds, ...extra })],
        isError: true,
      });

      if (childIds.includes(parentId)) {
        return refuse("The parent ticket cannot also be a child. Nothing was changed.");
      }

      // Read every ticket first: nothing is written until all of them pass.
      const read = async (id: number): Promise<TicketRecord | null> => {
        try {
          return await client.get<TicketRecord>(`/service/tickets/${id}`);
        } catch (err: unknown) {
          if (hasApiStatus(err, 404)) return null;
          throw err;
        }
      };
      const parent = await read(parentId);
      const children = new Map<number, TicketRecord | null>();
      for (const id of childIds) children.set(id, await read(id));

      const missing = [parent === null ? parentId : null, ...childIds.filter((id) => children.get(id) === null)].filter(
        (id): id is number => id !== null,
      );
      if (missing.length > 0 || parent === null) {
        return refuse(`Ticket ${missing.join(", ")} was not found. Nothing was changed.`, { missing });
      }
      const childRecords = childIds.map((id) => children.get(id) as TicketRecord);

      const closed = [parent, ...childRecords].filter((t) => t.closedFlag === true).map((t) => t.id);
      if (closed.length > 0) {
        return refuse(`Ticket ${closed.join(", ")} is already closed, so nothing is merged. Nothing was changed.`, {
          closed,
        });
      }
      const parentCompany = parent.company?.id;
      const otherCompany = childRecords
        .filter((t) => t.company?.id !== parentCompany)
        .map((t) => ({ id: t.id ?? null, company: t.company?.name ?? null }));
      if (otherCompany.length > 0) {
        return refuse(
          `Ticket ${otherCompany.map((t) => t.id).join(", ")} belongs to a different company from the parent, so it is not merged. Nothing was changed.`,
          { parentCompany: parent.company?.name ?? null, otherCompany },
        );
      }

      // The closed status for the children, read from their board.
      let mergeStatusId = statusId;
      let mergeStatusName: string | null = null;
      let statusNeed: Record<string, unknown> | undefined;
      if (mergeStatusId === undefined) {
        const boardIds = [...new Set(childRecords.map((t) => t.board?.id))];
        if (boardIds.length !== 1 || boardIds[0] === undefined) {
          statusNeed = {
            reason: "The children are on more than one board, so no single closed status applies. Pass statusId.",
          };
        } else {
          const statuses = await fetchAllPages<BoardStatus>(
            client,
            `/service/boards/${boardIds[0]}/statuses`,
          );
          const active = statuses.filter((s) => s.inactive !== true);
          const closedOnes = active.filter((s) => s.closedStatus === true);
          if (closedOnes.length === 1 && typeof closedOnes[0].id === "number") {
            mergeStatusId = closedOnes[0].id;
            mergeStatusName = closedOnes[0].name ?? null;
          } else {
            const shown = (closedOnes.length > 0 ? closedOnes : active).map((s) => ({
              id: s.id ?? null,
              name: s.name ?? null,
              closed: s.closedStatus === true,
            }));
            statusNeed = {
              reason:
                closedOnes.length > 1
                  ? "The board has more than one closed status. Pass statusId for the one to use."
                  : "No status on the board is marked closed. Pass statusId for the closed status to use.",
              boardId: boardIds[0],
              statuses: shown,
            };
          }
        }
      }

      const plan = {
        parent: row(parent),
        children: childRecords.map(row),
        status: mergeStatusId === undefined ? null : { id: mergeStatusId, name: mergeStatusName },
      };

      if (mergeStatusId === undefined) {
        return refuse("The status to close the merged tickets with is not decided. Nothing was changed.", {
          plan,
          statusNeeded: statusNeed,
        });
      }

      if (confirm !== true) {
        return {
          content: [
            text({
              merged: false,
              message: "No write was made. Pass confirm: true to merge these tickets.",
              parentId,
              childIds,
              plan,
            }),
          ],
          isError: true,
        };
      }

      try {
        await client.post(`/service/tickets/${parentId}/merge`, {
          mergeTicketIds: childIds,
          status: { id: mergeStatusId },
        });
      } catch (err: unknown) {
        if (!isInactiveCompanyError(err)) throw err;
        const finding = await findInactiveCompany(client, { ticketId: parentId });
        return {
          content: [
            text({
              merged: false,
              reason: "inactive-company",
              message: inactiveCompanyMessage(finding, {
                ticketId: parentId,
                verb: "merged",
                remedy:
                  "Move the tickets to an active company first, with cw_update_ticket and newCompanyId, then merge.",
              }),
              company: finding.company,
              companyStatus: finding.status,
            }),
          ],
          isError: true,
        };
      }

      // Read everything back.
      const freshParent = await client.get<TicketRecord>(`/service/tickets/${parentId}`);
      const freshChildren: TicketRecord[] = [];
      for (const id of childIds) {
        freshChildren.push(await client.get<TicketRecord>(`/service/tickets/${id}`));
      }
      const childRows = freshChildren.map((t) => ({
        ...row(t),
        closedWithStatus: t.status?.id === mergeStatusId,
      }));
      const mergedOk = childRows.every((r) => r.closed);

      // The note on the parent.
      const listed = childRecords
        .map(
          (t) =>
            `#${t.id} "${t.summary ?? ""}" (${t.board?.name ?? "no board"}, ${t.status?.name ?? "no status"})`,
        )
        .join("; ");
      const noteText =
        `Merged into this ticket: ${listed}. ` +
        `The merged tickets were closed with the status ${mergeStatusName ? `"${mergeStatusName}"` : `id ${mergeStatusId}`}.`;
      let noteId: number | null = null;
      let noteError: string | undefined;
      try {
        const created = await client.post<Record<string, unknown>>(`/service/tickets/${parentId}/notes`, {
          text: noteText,
          internalAnalysisFlag: true,
        });
        noteId = typeof created?.id === "number" ? created.id : null;
      } catch (err: unknown) {
        noteError = err instanceof Error ? err.message : String(err);
      }
      let noteReadBack = false;
      if (noteId !== null) {
        try {
          const notes = await client.get<Array<{ id?: number }>>(`/service/tickets/${parentId}/notes`, {
            pageSize: 10,
            orderBy: "id desc",
          });
          noteReadBack = Array.isArray(notes) && notes.some((n) => n.id === noteId);
        } catch {
          /* reported as not read back */
        }
      }

      const ok = mergedOk && freshParent.closedFlag !== true && noteId !== null && noteReadBack;
      return {
        content: [
          text({
            merged: true,
            verified: ok,
            parent: row(freshParent),
            children: childRows,
            status: { id: mergeStatusId, name: mergeStatusName },
            note: {
              added: noteId !== null,
              id: noteId,
              readBack: noteReadBack,
              text: noteText,
              ...(noteError ? { error: noteError } : {}),
            },
            ...(noteId === null
              ? { warning: "The tickets were merged but the parent note was not added. Add the note text above by hand." }
              : {}),
          }),
        ],
        isError: !ok,
      };
    },
  );
}

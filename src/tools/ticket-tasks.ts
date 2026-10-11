import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient } from "../api-client.js";
import { fetchAllPages } from "./paging.js";

/**
 * Service ticket task tools (ConnectWise Service API).
 *
 * A ticket task is one line of the checklist ConnectWise shows on the Tasks
 * tab of a service ticket. There is deliberately no delete tool here.
 */

const TICKET_TASK_READ_ONLY = { readOnlyHint: true };
/** Updating a task overwrites fields on an existing record. */
const TICKET_TASK_WRITE = { readOnlyHint: false, destructiveHint: true };

interface TicketTaskPatchOperation {
  op: "replace";
  path: "closedFlag" | "notes";
  value: boolean | string;
}

/**
 * Build the JSON Patch for a ticket task. closedFlag and notes are the only
 * two paths this server ever sends for a task, by contract.
 */
export function buildTicketTaskPatch(change: {
  closedFlag?: boolean;
  notes?: string;
}): TicketTaskPatchOperation[] {
  const operations: TicketTaskPatchOperation[] = [];
  if (change.closedFlag !== undefined) {
    operations.push({ op: "replace", path: "closedFlag", value: change.closedFlag });
  }
  if (change.notes !== undefined) {
    operations.push({ op: "replace", path: "notes", value: change.notes });
  }
  return operations;
}

/** A ticket task as ConnectWise returns it. Only the lean fields are named. */
interface TicketTaskRecord {
  id?: number;
  notes?: string | null;
  closedFlag?: boolean | null;
  priority?: number | null;
  resolution?: string | null;
}

/** The lean shape every ticket task tool returns. */
export interface LeanTicketTask {
  id: number | null;
  notes: string | null;
  closedFlag: boolean;
  priority: number | null;
  resolution: string | null;
}

/** Reduce a ConnectWise ticket task to the lean shape, with stable keys. */
export function toLeanTicketTask(task: TicketTaskRecord): LeanTicketTask {
  return {
    id: task.id ?? null,
    notes: task.notes ?? null,
    closedFlag: task.closedFlag === true,
    priority: task.priority ?? null,
    resolution: task.resolution ?? null,
  };
}

/**
 * Register the service ticket task tools on the MCP server.
 *
 * @param server MCP server to register tools on.
 * @param client ConnectWise Manage client used by the tools.
 */
export function registerTicketTaskTools(server: McpServer, client: CwManageClient) {
  server.tool(
    "cw_get_ticket_tasks",
    "Get every task on a service ticket (the checklist on the ticket's Tasks tab). Returns each task lean: id, notes, closedFlag, priority and resolution. Reads all pages, so the list is complete. Tasks come back in priority order.",
    {
      id: z.number().int().positive().describe("Service ticket ID"),
    },
    TICKET_TASK_READ_ONLY,
    async ({ id }) => {
      const records = await fetchAllPages<TicketTaskRecord>(
        client,
        `/service/tickets/${id}/tasks`,
      );
      // Sorted here, not with orderBy, so the request carries nothing the
      // endpoint could reject. A task with no priority sorts last.
      const tasks = records
        .map(toLeanTicketTask)
        .sort(
          (a, b) =>
            (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER),
        );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ticketId: id, count: tasks.length, tasks }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "cw_update_ticket_task",
    "Update one task on a service ticket. Only closedFlag and notes can change: set closedFlag to true to close the task, false to reopen it. Requires confirm: true. Without it nothing is written and the planned change is returned. After the write the task is read back, and the response is that fresh read. Close a task only when the user has named it. There is no delete tool for ticket tasks.",
    {
      ticketId: z.number().int().positive().describe("Service ticket ID"),
      id: z.number().int().positive().describe("Task ID, from cw_get_ticket_tasks"),
      closedFlag: z
        .boolean()
        .optional()
        .describe("true closes the task, false reopens it. Omit to leave it unchanged"),
      notes: z
        .string()
        .min(1)
        .optional()
        .describe("New task text. Omit to leave it unchanged"),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true for the write to happen. Omitted or false makes no write"),
    },
    TICKET_TASK_WRITE,
    async ({ ticketId, id, closedFlag, notes, confirm }) => {
      const operations = buildTicketTaskPatch({ closedFlag, notes });
      const path = `/service/tickets/${ticketId}/tasks/${id}`;

      if (operations.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Nothing to update. Pass closedFlag, notes, or both. No request was made.",
            },
          ],
          isError: true,
        };
      }

      if (confirm !== true) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  saved: false,
                  message: "No write was made. Pass confirm: true to apply this change.",
                  ticketId,
                  taskId: id,
                  planned: operations,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      await client.patch(path, operations);

      // Read the task back so the response reports what ConnectWise now holds,
      // not what was sent.
      const task = toLeanTicketTask(await client.get<TicketTaskRecord>(path));
      const mismatches: string[] = [];
      if (closedFlag !== undefined && task.closedFlag !== closedFlag) mismatches.push("closedFlag");
      if (notes !== undefined && task.notes !== notes) mismatches.push("notes");
      const verified = mismatches.length === 0;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                saved: true,
                verified,
                ...(verified ? {} : { mismatches }),
                ticketId,
                task,
              },
              null,
              2,
            ),
          },
        ],
        isError: !verified,
      };
    },
  );
}

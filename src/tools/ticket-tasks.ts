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
}

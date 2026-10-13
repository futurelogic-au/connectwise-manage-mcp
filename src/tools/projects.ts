import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient, hasApiStatus } from "../api-client.js";
import { mapCreatedNoteResponse } from "./note-payload.js";
import { fetchAllPages } from "./paging.js";

/** How a project bills, as ConnectWise's Project.billingMethod accepts it. */
export const PROJECT_BILLING_METHODS = ["ActualRates", "FixedFee", "NotToExceed", "OverrideRate"] as const;

const PROJECT_READ_ONLY = { readOnlyHint: true };
/** Creating a project or a project ticket only adds a record. */
const PROJECT_ADDITIVE_WRITE = { readOnlyHint: false, destructiveHint: false };

/** A project date: present, not blank, and one that Date can read. Refused before any request. */
const PROJECT_DATE = z
  .string()
  .trim()
  .min(1, "A date is required")
  .refine((value) => !Number.isNaN(Date.parse(value)), "Must be an ISO 8601 date, such as 2026-11-02T00:00:00Z");

function text(value: unknown) {
  return { type: "text" as const, text: JSON.stringify(value, null, 2) };
}

/** A Manage reference reduced to its id and labels. */
function refOf(value: unknown): { id: number | null; name: string | null } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { id?: unknown; name?: unknown; identifier?: unknown };
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

function lastUpdated(record: Record<string, unknown>): string | null {
  const info = record._info as { lastUpdated?: unknown } | undefined;
  return typeof info?.lastUpdated === "string" ? info.lastUpdated : null;
}

/** The lean shape cw_create_project returns after its read back. */
function leanProject(project: Record<string, unknown>) {
  return {
    id: typeof project.id === "number" ? project.id : null,
    name: typeof project.name === "string" ? project.name : null,
    board: refOf(project.board),
    company: refOf(project.company),
    status: refOf(project.status),
    manager: refOf(project.manager),
    billingMethod: typeof project.billingMethod === "string" ? project.billingMethod : null,
    billingAmount: typeof project.billingAmount === "number" ? project.billingAmount : null,
    agreement: refOf(project.agreement),
    estimatedStart: typeof project.estimatedStart === "string" ? project.estimatedStart : null,
    estimatedEnd: typeof project.estimatedEnd === "string" ? project.estimatedEnd : null,
    _info: { lastUpdated: lastUpdated(project) },
  };
}

export function registerProjectTools(server: McpServer, client: CwManageClient) {
  server.tool(
    "cw_search_projects",
    "Search projects in ConnectWise Manage.",
    {
      conditions: z.string().optional().describe("ConnectWise conditions query string"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
      orderBy: z.string().optional().describe("Field to order by"),
    },
    async ({ conditions, page, pageSize, orderBy }) => {
      const result = await client.get("/project/projects", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_get_project",
    "Get a specific project by ID.",
    {
      id: z.number().describe("Project ID"),
    },
    async ({ id }) => {
      const result = await client.get(`/project/projects/${id}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_search_project_tickets",
    "Search tickets under a project. Use projectId to filter by project, or conditions for CW query syntax.",
    {
      projectId: z.number().optional().describe("Filter by project ID"),
      conditions: z.string().optional().describe("ConnectWise conditions query string"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
      orderBy: z.string().optional().describe("Field to order by (e.g. 'id desc')"),
    },
    async ({ projectId, conditions, page, pageSize, orderBy }) => {
      const conditionParts: string[] = [];
      if (projectId !== undefined) conditionParts.push(`project/id=${projectId}`);
      if (conditions) conditionParts.push(conditions);

      const result = await client.get("/project/tickets", {
        conditions: conditionParts.join(" and ") || undefined,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_get_project_ticket",
    "Get a specific project ticket by ID.",
    {
      id: z.number().describe("Project ticket ID"),
    },
    async ({ id }) => {
      const result = await client.get(`/project/tickets/${id}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_get_project_ticket_notes",
    "Get all notes on a project ticket, including notes from any child tickets.",
    {
      id: z.number().describe("Project ticket ID"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
    },
    async ({ id, page, pageSize }) => {
      try {
        const result = await client.get(`/project/tickets/${id}/allNotes`, {
          page: page ?? 1,
          pageSize: pageSize ?? 25,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err: unknown) {
        if (hasApiStatus(err, 404, 405)) {
          // allNotes not supported on this CWM version — fall back to /notes
          const result = await client.get(`/project/tickets/${id}/notes`, {
            page: page ?? 1,
            pageSize: pageSize ?? 25,
          });
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        throw err;
      }
    },
  );

  server.tool(
    "cw_add_project_ticket_note",
    "Add a note to a project ticket. Use internalAnalysisFlag for internal-only notes or resolutionFlag for resolution notes. Defaults to a plain discussion note.",
    {
      id: z.number().describe("Project ticket ID"),
      text: z.string().describe("Note text content"),
      detailDescriptionFlag: z.boolean().optional().describe("Add as detail description (default: false)"),
      internalAnalysisFlag: z.boolean().optional().describe("Mark as internal analysis only (default: false)"),
      resolutionFlag: z.boolean().optional().describe("Mark as resolution note (default: false)"),
    },
    async ({ id, text, detailDescriptionFlag, internalAnalysisFlag, resolutionFlag }) => {
      const body: Record<string, unknown> = { text };
      if (detailDescriptionFlag !== undefined) body.detailDescriptionFlag = detailDescriptionFlag;
      if (internalAnalysisFlag !== undefined) body.internalAnalysisFlag = internalAnalysisFlag;
      if (resolutionFlag !== undefined) body.resolutionFlag = resolutionFlag;

      const result = await client.post<Record<string, unknown>>(`/project/tickets/${id}/notes`, body);
      const mapped = mapCreatedNoteResponse(result, {
        detailDescriptionFlag,
        internalAnalysisFlag,
        resolutionFlag,
      });
      return { content: [{ type: "text", text: JSON.stringify(mapped, null, 2) }] };
    },
  );

  server.tool(
    "cw_list_project_phases",
    "List the phases of a project (GET /project/projects/{id}/phases). Use this to find the phaseId that cw_create_project_ticket needs.",
    {
      projectId: z.number().int().positive().describe("Project ID"),
    },
    PROJECT_READ_ONLY,
    async ({ projectId }) => {
      const phases = await fetchAllPages<Record<string, unknown>>(
        client,
        `/project/projects/${projectId}/phases`,
      );
      const lean = phases.map((phase) => ({
        id: typeof phase.id === "number" ? phase.id : null,
        description: typeof phase.description === "string" ? phase.description : null,
        status: refOf(phase.status),
      }));
      return {
        content: [text({ projectId, count: lean.length, phases: lean })],
      };
    },
  );

  server.tool(
    "cw_create_project",
    "Create a new project. billingMethod and agreementId are required and have no default: say how the project bills, and which agreement it bills to (or null for none). estimatedStart and estimatedEnd are required too, because ConnectWise rejects a project without them; a call that leaves one out is refused before any request. Requires confirm: true. Without it nothing is written and the planned body is returned. After the write the project is read back and the response is that fresh read, with a verified flag for the billing method and agreement.",
    {
      name: z.string().max(100).describe("Project name"),
      boardId: z.number().describe("Project board ID"),
      companyId: z.number().describe("Company ID"),
      billingMethod: z
        .enum(PROJECT_BILLING_METHODS)
        .describe("How the project bills. Required, no default"),
      agreementId: z
        .number()
        .int()
        .positive()
        .nullable()
        .describe("Agreement ID the project bills against, or null for no agreement. Required, no default"),
      billingAmount: z
        .number()
        .nonnegative()
        .optional()
        .describe("Amount for FixedFee or NotToExceed. Omit for ActualRates"),
      estimatedStart: PROJECT_DATE.describe("Estimated start date (ISO 8601). Required: ConnectWise rejects a project without it"),
      estimatedEnd: PROJECT_DATE.describe("Estimated end date (ISO 8601). Required: ConnectWise rejects a project without it"),
      description: z.string().optional().describe("Project description"),
      managerId: z.number().optional().describe("Project manager member ID"),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true for the project to be created. Omitted or false makes no write"),
    },
    PROJECT_ADDITIVE_WRITE,
    async ({
      name,
      boardId,
      companyId,
      billingMethod,
      agreementId,
      billingAmount,
      estimatedStart,
      estimatedEnd,
      description,
      managerId,
      confirm,
    }) => {
      const body: Record<string, unknown> = {
        name,
        board: { id: boardId },
        company: { id: companyId },
        billingMethod,
      };
      if (agreementId !== null) body.agreement = { id: agreementId };
      if (billingAmount !== undefined) body.billingAmount = billingAmount;
      body.estimatedStart = estimatedStart;
      body.estimatedEnd = estimatedEnd;
      if (description) body.description = description;
      if (managerId) body.manager = { id: managerId };

      if (confirm !== true) {
        return {
          content: [
            text({
              saved: false,
              message: "No write was made. Pass confirm: true to create this project.",
              planned: body,
            }),
          ],
          isError: true,
        };
      }

      const created = await client.post<Record<string, unknown>>("/project/projects", body);
      const id = typeof created?.id === "number" ? created.id : undefined;
      if (id === undefined) {
        return {
          content: [
            text({
              saved: true,
              verified: false,
              message: "ConnectWise did not return a project id, so the project could not be read back.",
            }),
          ],
          isError: true,
        };
      }

      // Read it back so the response reports what ConnectWise now holds.
      const fresh = await client.get<Record<string, unknown>>(`/project/projects/${id}`);
      const mismatches: string[] = [];
      if (fresh.billingMethod !== billingMethod) mismatches.push("billingMethod");
      const freshAgreement = (fresh.agreement as { id?: number } | null | undefined)?.id ?? null;
      if (freshAgreement !== agreementId) mismatches.push("agreement");
      const verified = mismatches.length === 0;
      return {
        content: [
          text({
            saved: true,
            verified,
            ...(verified ? {} : { mismatches }),
            project: leanProject(fresh),
          }),
        ],
        isError: !verified,
      };
    },
  );

  server.tool(
    "cw_create_project_ticket",
    "Create a ticket on a project phase (POST /project/tickets). Requires confirm: true. Without it nothing is written and the planned body is returned. The phase must belong to the project: find it with cw_list_project_phases. After the write the ticket is read back and the response is that fresh read, with a verified flag for the project and phase.",
    {
      projectId: z.number().int().positive().describe("Project ID"),
      phaseId: z.number().int().positive().describe("Phase ID, from cw_list_project_phases"),
      summary: z.string().min(1).max(100).describe("Ticket summary"),
      statusId: z.number().int().positive().optional().describe("Ticket status ID"),
      priorityId: z.number().int().positive().optional().describe("Priority ID"),
      typeId: z.number().int().positive().optional().describe("Type ID"),
      subTypeId: z.number().int().positive().optional().describe("Sub type ID"),
      ownerId: z.number().int().positive().optional().describe("Owner member ID"),
      budgetHours: z.number().nonnegative().optional().describe("Budget hours"),
      initialDescription: z.string().optional().describe("Initial ticket description"),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true for the ticket to be created. Omitted or false makes no write"),
    },
    PROJECT_ADDITIVE_WRITE,
    async ({
      projectId,
      phaseId,
      summary,
      statusId,
      priorityId,
      typeId,
      subTypeId,
      ownerId,
      budgetHours,
      initialDescription,
      confirm,
    }) => {
      const body: Record<string, unknown> = {
        summary,
        project: { id: projectId },
        phase: { id: phaseId },
      };
      if (statusId) body.status = { id: statusId };
      if (priorityId) body.priority = { id: priorityId };
      if (typeId) body.type = { id: typeId };
      if (subTypeId) body.subType = { id: subTypeId };
      if (ownerId) body.owner = { id: ownerId };
      if (budgetHours !== undefined) body.budgetHours = budgetHours;
      if (initialDescription) body.initialDescription = initialDescription;

      // The phase has to belong to the project. This read is a check, not a
      // dependency: if the phase list cannot be read, ConnectWise validates.
      try {
        const phases = await fetchAllPages<{ id?: number }>(
          client,
          `/project/projects/${projectId}/phases`,
        );
        if (phases.length > 0 && !phases.some((phase) => phase.id === phaseId)) {
          return {
            content: [
              text({
                saved: false,
                refused: true,
                message: `Phase ${phaseId} is not a phase of project ${projectId}. Nothing was changed.`,
                phaseIds: phases.map((phase) => phase.id ?? null),
              }),
            ],
            isError: true,
          };
        }
      } catch {
        /* ConnectWise validates the phase on the write */
      }

      if (confirm !== true) {
        return {
          content: [
            text({
              saved: false,
              message: "No write was made. Pass confirm: true to create this project ticket.",
              planned: body,
            }),
          ],
          isError: true,
        };
      }

      const created = await client.post<Record<string, unknown>>("/project/tickets", body);
      const id = typeof created?.id === "number" ? created.id : undefined;
      if (id === undefined) {
        return {
          content: [
            text({
              saved: true,
              verified: false,
              message: "ConnectWise did not return a ticket id, so the ticket could not be read back.",
            }),
          ],
          isError: true,
        };
      }

      const fresh = await client.get<Record<string, unknown>>(`/project/tickets/${id}`);
      const mismatches: string[] = [];
      if ((fresh.project as { id?: number } | null | undefined)?.id !== projectId) mismatches.push("project");
      if ((fresh.phase as { id?: number } | null | undefined)?.id !== phaseId) mismatches.push("phase");
      if (fresh.summary !== summary) mismatches.push("summary");
      const verified = mismatches.length === 0;
      return {
        content: [
          text({
            saved: true,
            verified,
            ...(verified ? {} : { mismatches }),
            ticket: {
              id: fresh.id ?? null,
              summary: fresh.summary ?? null,
              project: refOf(fresh.project),
              phase: refOf(fresh.phase),
              board: refOf(fresh.board),
              status: refOf(fresh.status),
              company: refOf(fresh.company),
              owner: refOf(fresh.owner),
              _info: { lastUpdated: lastUpdated(fresh) },
            },
          }),
        ],
        isError: !verified,
      };
    },
  );
}

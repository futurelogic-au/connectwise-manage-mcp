import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient } from "../api-client.js";
import { fetchAllPages } from "./paging.js";

/**
 * Agreement work role and work type exclusions.
 *
 * An exclusion keeps a work role or a work type out of an agreement's coverage.
 * ConnectWise holds them as two child collections of an agreement:
 *
 *   /finance/agreements/{id}/workroleexclusions
 *   /finance/agreements/{id}/worktypeexclusions
 *
 * GET lists, POST adds, DELETE /{exclusionId} removes (ruling D25: confirm: true,
 * and list before delete). Delete is the only delete in this server that reaches
 * an agreement record, and it removes one exclusion row, never the agreement.
 */

const KINDS = {
  workrole: { path: "workroleexclusions", field: "workRole", label: "work role" },
  worktype: { path: "worktypeexclusions", field: "workType", label: "work type" },
} as const;

type Kind = keyof typeof KINDS;

interface ExclusionRecord {
  id?: number;
  agreementId?: number;
  workRole?: { id?: number; name?: string } | null;
  workType?: { id?: number; name?: string } | null;
}

const READ_ONLY = { readOnlyHint: true };
const ADD = { readOnlyHint: false, destructiveHint: false };
const DELETE = { readOnlyHint: false, destructiveHint: true };

function text(value: unknown) {
  return { type: "text" as const, text: JSON.stringify(value, null, 2) };
}

function leanExclusion(kind: Kind, record: ExclusionRecord) {
  const target = kind === "workrole" ? record.workRole : record.workType;
  return {
    exclusionId: typeof record.id === "number" ? record.id : null,
    kind,
    targetId: typeof target?.id === "number" ? target.id : null,
    targetName: typeof target?.name === "string" ? target.name : null,
  };
}

export function registerAgreementExclusionTools(server: McpServer, client: CwManageClient) {
  const list = (agreementId: number, kind: Kind) =>
    fetchAllPages<ExclusionRecord>(client, `/finance/agreements/${agreementId}/${KINDS[kind].path}`);

  server.tool(
    "cw_list_agreement_exclusions",
    "List the work role and work type exclusions on an agreement (GET /finance/agreements/{id}/workroleexclusions and /worktypeexclusions). Each row has the exclusionId that cw_delete_agreement_exclusion takes. Omit kind to list both. Read-only.",
    {
      agreementId: z.number().int().positive().describe("Agreement ID"),
      kind: z.enum(["workrole", "worktype"]).optional().describe("Which exclusions to list. Omit for both"),
    },
    READ_ONLY,
    async ({ agreementId, kind }) => {
      const kinds: Kind[] = kind ? [kind] : ["workrole", "worktype"];
      const exclusions = [];
      for (const k of kinds) {
        for (const record of await list(agreementId, k)) exclusions.push(leanExclusion(k, record));
      }
      return { content: [text({ agreementId, count: exclusions.length, exclusions })] };
    },
  );

  server.tool(
    "cw_add_agreement_exclusion",
    "Exclude a work role or a work type from an agreement (POST /finance/agreements/{id}/workroleexclusions or /worktypeexclusions). Pass exactly one of workRoleId and workTypeId. An exclusion that is already there is reported and nothing is written. Requires confirm: true. Without it nothing is written and the plan is returned. After the write the agreement's exclusions are read back.",
    {
      agreementId: z.number().int().positive().describe("Agreement ID"),
      workRoleId: z.number().int().positive().optional().describe("Work role to exclude"),
      workTypeId: z.number().int().positive().optional().describe("Work type to exclude"),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true for the exclusion to be added. Omitted or false makes no write"),
    },
    ADD,
    async ({ agreementId, workRoleId, workTypeId, confirm }) => {
      if ((workRoleId === undefined) === (workTypeId === undefined)) {
        return {
          content: [
            text({
              added: false,
              refused: true,
              message: "Pass exactly one of workRoleId and workTypeId.",
              agreementId,
            }),
          ],
          isError: true,
        };
      }
      const kind: Kind = workRoleId !== undefined ? "workrole" : "worktype";
      const targetId = (workRoleId ?? workTypeId) as number;
      const meta = KINDS[kind];

      const existing = (await list(agreementId, kind)).filter((record) => {
        const target = kind === "workrole" ? record.workRole : record.workType;
        return target?.id === targetId;
      });
      if (existing.length > 0) {
        return {
          content: [
            text({
              added: false,
              alreadyPresent: true,
              message: `The agreement already excludes this ${meta.label}. Nothing was changed.`,
              agreementId,
              exclusion: leanExclusion(kind, existing[0]),
            }),
          ],
        };
      }

      const body = { agreementId, [meta.field]: { id: targetId } };
      if (confirm !== true) {
        return {
          content: [
            text({
              added: false,
              message: "No write was made. Pass confirm: true to add this exclusion.",
              agreementId,
              planned: { kind, ...body },
            }),
          ],
          isError: true,
        };
      }

      await client.post(`/finance/agreements/${agreementId}/${meta.path}`, body);

      const after = await list(agreementId, kind);
      const added = after.find((record) => {
        const target = kind === "workrole" ? record.workRole : record.workType;
        return target?.id === targetId;
      });
      return {
        content: [
          text({
            added: added !== undefined,
            verified: added !== undefined,
            agreementId,
            exclusion: added ? leanExclusion(kind, added) : null,
            exclusions: after.map((record) => leanExclusion(kind, record)),
          }),
        ],
        isError: added === undefined,
      };
    },
  );

  server.tool(
    "cw_delete_agreement_exclusion",
    "Remove one exclusion from an agreement (DELETE /finance/agreements/{id}/workroleexclusions/{exclusionId} or /worktypeexclusions/{exclusionId}). The agreement's exclusions are listed first, and only an exclusion on that agreement is deleted. Requires confirm: true. Without it nothing is written and the exclusion that would go is returned. After the delete the exclusions are read back. It removes the exclusion row only, never the agreement.",
    {
      agreementId: z.number().int().positive().describe("Agreement ID"),
      kind: z.enum(["workrole", "worktype"]).describe("Which kind of exclusion"),
      exclusionId: z
        .number()
        .int()
        .positive()
        .describe("Exclusion ID, from cw_list_agreement_exclusions"),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true for the exclusion to be deleted. Omitted or false makes no write"),
    },
    DELETE,
    async ({ agreementId, kind, exclusionId, confirm }) => {
      const meta = KINDS[kind];
      const before = await list(agreementId, kind);
      const match = before.find((record) => record.id === exclusionId);
      if (!match) {
        return {
          content: [
            text({
              deleted: false,
              refused: true,
              message: `Agreement ${agreementId} has no ${meta.label} exclusion ${exclusionId}. Nothing was changed.`,
              exclusions: before.map((record) => leanExclusion(kind, record)),
            }),
          ],
          isError: true,
        };
      }

      if (confirm !== true) {
        return {
          content: [
            text({
              deleted: false,
              message: "No write was made. Pass confirm: true to delete this exclusion.",
              agreementId,
              planned: leanExclusion(kind, match),
            }),
          ],
          isError: true,
        };
      }

      await client.delete(`/finance/agreements/${agreementId}/${meta.path}/${exclusionId}`);

      const after = await list(agreementId, kind);
      const stillThere = after.some((record) => record.id === exclusionId);
      return {
        content: [
          text({
            deleted: !stillThere,
            verified: !stillThere,
            agreementId,
            removed: leanExclusion(kind, match),
            exclusions: after.map((record) => leanExclusion(kind, record)),
          }),
        ],
        isError: stillThere,
      };
    },
  );
}

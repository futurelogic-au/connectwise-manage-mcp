import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient, hasApiStatus } from "../api-client.js";
import { fetchAllPages } from "./paging.js";
import { quoteCwString } from "./contact-type-update.js";

/**
 * Company types.
 *
 * Manage's Company.types is a child collection: PATCH /company/companies/{id}
 * does not change it, so cw_update_company refuses type paths. A company's
 * types are read and changed through /company/companies/{id}/typeAssociations:
 * GET lists, POST adds an association, DELETE removes one.
 *
 * The add falls back to POST /company/companyTypeAssociations, the top-level
 * collection, when the nested POST answers 404 or 405. The response says which
 * path took the write.
 */

const TYPE_READ_ONLY = { readOnlyHint: true };
const TYPE_ADD = { readOnlyHint: false, destructiveHint: false };
const TYPE_REMOVE = { readOnlyHint: false, destructiveHint: true };

interface TypeRecord {
  id?: number;
  name?: string;
}

interface TypeAssociation {
  id?: number;
  type?: TypeRecord | null;
}

const COMPANY_TYPE_PATCH_PATH = /^\/?(?:types|typeIds)(?:\/.*)?$/;

/** True when a company patch operation targets the types collection. */
export function companyPatchTouchesTypes(path: string): boolean {
  return COMPANY_TYPE_PATCH_PATH.test(path);
}

export const COMPANY_TYPE_PATCH_ERROR =
  "Company types are a child collection and cannot be changed with cw_update_company. Use cw_add_company_type_association and cw_remove_company_type_association, which go through /company/companies/{id}/typeAssociations.";

function text(value: unknown) {
  return { type: "text" as const, text: JSON.stringify(value, null, 2) };
}

function lean(association: TypeAssociation) {
  return {
    associationId: typeof association.id === "number" ? association.id : null,
    typeId: typeof association.type?.id === "number" ? association.type.id : null,
    typeName: typeof association.type?.name === "string" ? association.type.name : null,
  };
}

/** Resolve a type name against the company type catalogue. One exact match, or an error message. */
async function resolveType(
  client: CwManageClient,
  input: { typeId?: number; typeName?: string },
): Promise<{ id: number; name: string | null } | { error: string }> {
  if (input.typeId !== undefined) return { id: input.typeId, name: null };
  const wanted = input.typeName?.trim();
  if (!wanted) return { error: "Pass typeId or typeName." };

  const catalogue = await fetchAllPages<TypeRecord>(client, "/company/companies/types");
  const matches = catalogue.filter(
    (type): type is { id: number; name: string } =>
      typeof type.id === "number" &&
      typeof type.name === "string" &&
      type.name.toLowerCase() === wanted.toLowerCase(),
  );
  if (matches.length === 1) return matches[0];
  const quoted = quoteCwString(wanted);
  return {
    error:
      matches.length === 0
        ? `No company type named ${quoted}. The name must match a type from /company/companies/types.`
        : `More than one company type is named ${quoted}. Pass typeId instead.`,
  };
}

export function registerCompanyTypeTools(server: McpServer, client: CwManageClient) {
  const listAssociations = (companyId: number) =>
    fetchAllPages<TypeAssociation>(client, `/company/companies/${companyId}/typeAssociations`);

  server.tool(
    "cw_list_company_types",
    "List the company types ConnectWise holds (GET /company/companies/types), so a typeId or typeName for cw_add_company_type_association is read, not guessed. Read-only.",
    {},
    TYPE_READ_ONLY,
    async () => {
      const catalogue = await fetchAllPages<TypeRecord & { defaultFlag?: boolean; inactiveFlag?: boolean }>(
        client,
        "/company/companies/types",
      );
      const types = catalogue.map((type) => ({
        id: typeof type.id === "number" ? type.id : null,
        name: typeof type.name === "string" ? type.name : null,
      }));
      return { content: [text({ count: types.length, types })] };
    },
  );

  server.tool(
    "cw_list_company_type_associations",
    "List the types a company holds (GET /company/companies/{id}/typeAssociations). Each row is the association ID, which cw_remove_company_type_association can take, and the type's ID and name. Read-only.",
    {
      companyId: z.number().int().positive().describe("Company ID"),
    },
    TYPE_READ_ONLY,
    async ({ companyId }) => {
      const associations = (await listAssociations(companyId)).map(lean);
      return { content: [text({ companyId, count: associations.length, associations })] };
    },
  );

  server.tool(
    "cw_add_company_type_association",
    "Add a type to a company (POST /company/companies/{id}/typeAssociations). cw_update_company cannot change types. Pass typeId, or typeName to be matched against the company type catalogue. A type the company already holds is reported and nothing is written. Requires confirm: true. Without it nothing is written and the plan is returned. After the write the company's types are read back.",
    {
      companyId: z.number().int().positive().describe("Company ID"),
      typeId: z.number().int().positive().optional().describe("Company type ID"),
      typeName: z.string().min(1).optional().describe('Company type name, for example "Client"'),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true for the type to be added. Omitted or false makes no write"),
    },
    TYPE_ADD,
    async ({ companyId, typeId, typeName, confirm }) => {
      const type = await resolveType(client, { typeId, typeName });
      if ("error" in type) {
        return { content: [text({ added: false, refused: true, message: type.error, companyId })], isError: true };
      }

      const existing = (await listAssociations(companyId)).filter((a) => a.type?.id === type.id);
      if (existing.length > 0) {
        return {
          content: [
            text({
              added: false,
              alreadyPresent: true,
              message: "The company already holds this type. Nothing was changed.",
              companyId,
              association: lean(existing[0]),
            }),
          ],
        };
      }

      if (confirm !== true) {
        return {
          content: [
            text({
              added: false,
              message: "No write was made. Pass confirm: true to add this type.",
              companyId,
              planned: { type: { id: type.id, ...(type.name ? { name: type.name } : {}) } },
            }),
          ],
          isError: true,
        };
      }

      let via = `/company/companies/${companyId}/typeAssociations`;
      try {
        await client.post(via, { type: { id: type.id }, company: { id: companyId } });
      } catch (err: unknown) {
        if (!hasApiStatus(err, 404, 405)) throw err;
        via = "/company/companyTypeAssociations";
        await client.post(via, { type: { id: type.id }, company: { id: companyId } });
      }

      const after = await listAssociations(companyId);
      const added = after.find((a) => a.type?.id === type.id);
      return {
        content: [
          text({
            added: added !== undefined,
            verified: added !== undefined,
            via,
            companyId,
            association: added ? lean(added) : null,
            types: after.map(lean),
          }),
        ],
        isError: added === undefined,
      };
    },
  );

  server.tool(
    "cw_remove_company_type_association",
    "Remove a type from a company (DELETE /company/companies/{id}/typeAssociations/{associationId}). Pass associationId, typeId or typeName. The company's associations are listed first and only a matching association is deleted. Requires confirm: true. Without it nothing is written and the matching associations are returned. After the delete the company's types are read back.",
    {
      companyId: z.number().int().positive().describe("Company ID"),
      associationId: z.number().int().positive().optional().describe("Association ID, from cw_list_company_type_associations"),
      typeId: z.number().int().positive().optional().describe("Company type ID"),
      typeName: z.string().min(1).optional().describe("Company type name"),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true for the type to be removed. Omitted or false makes no write"),
    },
    TYPE_REMOVE,
    async ({ companyId, associationId, typeId, typeName, confirm }) => {
      if (associationId === undefined && typeId === undefined && !typeName?.trim()) {
        return {
          content: [
            text({
              removed: false,
              refused: true,
              message: "Pass associationId, typeId or typeName.",
              companyId,
            }),
          ],
          isError: true,
        };
      }

      const associations = await listAssociations(companyId);
      let matches: TypeAssociation[];
      if (associationId !== undefined) {
        matches = associations.filter((a) => a.id === associationId);
      } else if (typeId !== undefined) {
        matches = associations.filter((a) => a.type?.id === typeId);
      } else {
        const wanted = typeName!.trim().toLowerCase();
        matches = associations.filter((a) => a.type?.name?.toLowerCase() === wanted);
      }

      if (matches.length === 0) {
        return {
          content: [
            text({
              removed: false,
              refused: true,
              message: "The company holds no matching type association. Nothing was changed.",
              companyId,
              types: associations.map(lean),
            }),
          ],
          isError: true,
        };
      }

      if (confirm !== true) {
        return {
          content: [
            text({
              removed: false,
              message: "No write was made. Pass confirm: true to remove these associations.",
              companyId,
              planned: matches.map(lean),
            }),
          ],
          isError: true,
        };
      }

      const removedIds: number[] = [];
      for (const match of matches) {
        if (typeof match.id !== "number") continue;
        await client.delete(`/company/companies/${companyId}/typeAssociations/${match.id}`);
        removedIds.push(match.id);
      }

      const after = await listAssociations(companyId);
      const stillThere = after.filter((a) => typeof a.id === "number" && removedIds.includes(a.id));
      return {
        content: [
          text({
            removed: removedIds.length > 0 && stillThere.length === 0,
            verified: stillThere.length === 0,
            companyId,
            removedAssociationIds: removedIds,
            types: after.map(lean),
          }),
        ],
        isError: removedIds.length === 0 || stillThere.length > 0,
      };
    },
  );
}

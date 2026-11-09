import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient } from "../api-client.js";
import { fetchAllPages } from "./paging.js";

/**
 * Setup write tools for service board items and subtypes.
 *
 * Ticket Categorisation (CW 908802) needs to change the items and subtypes on a
 * board. These follow cw_add_company_type_association: nothing is written
 * without confirm: true, a call without it returns the plan and the
 * before-image, and every write is read back from ConnectWise afterwards.
 *
 * Scope is deliberately narrow. There is no delete tool for an item or a
 * subtype, no tool on a type, and nothing on any other setup table. The
 * type, subtype and item association collection is GET only in ConnectWise's
 * published contract, so it has no write tool here.
 */

const SETUP_CREATE = { readOnlyHint: false, destructiveHint: false };
const SETUP_UPDATE = { readOnlyHint: false, destructiveHint: false };
const SETUP_UPDATE_LINKS = { readOnlyHint: false, destructiveHint: true };

type CwRecord = Record<string, unknown>;

function text(value: unknown) {
  return { type: "text" as const, text: JSON.stringify(value, null, 2) };
}

function asRecord(value: unknown): CwRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as CwRecord)
    : null;
}

function idsOf(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((id): id is number => typeof id === "number") : [];
}

function sameIds(a: number[], b: number[]): boolean {
  return a.length === b.length && [...a].sort((x, y) => x - y).every((id, i) => id === [...b].sort((x, y) => x - y)[i]);
}

/** A board item as id, name and inactiveFlag, with the board it sits on. */
export function toItemImage(item: CwRecord): CwRecord {
  const board = asRecord(item.board);
  return {
    id: item.id ?? null,
    name: item.name ?? null,
    inactiveFlag: item.inactiveFlag === true,
    boardId: typeof board?.id === "number" ? board.id : null,
  };
}

/** A board subtype as id, name, inactiveFlag and the type ids it is linked to. */
export function toSubtypeImage(subtype: CwRecord): CwRecord {
  const board = asRecord(subtype.board);
  return {
    id: subtype.id ?? null,
    name: subtype.name ?? null,
    inactiveFlag: subtype.inactiveFlag === true,
    typeAssociationIds: idsOf(subtype.typeAssociationIds),
    boardId: typeof board?.id === "number" ? board.id : null,
  };
}

const NO_WRITE = "No write was made. Pass confirm: true to apply the planned change.";

export function registerSetupWriteTools(server: McpServer, client: CwManageClient) {
  server.tool(
    "cw_create_board_item",
    "Create an item on a service board (POST /service/boards/{id}/items). Sends the name, and inactiveFlag when given. An item with the same name already on the board (ignoring case) is reported and nothing is written. Requires confirm: true. Without it nothing is written and the plan is returned with the before-image (the board's current item count). After the write the new item is read back and compared. There is no delete tool for items.",
    {
      boardId: z.number().int().positive().describe("Service board ID"),
      name: z.string().trim().min(1).max(50).describe("Item name"),
      inactiveFlag: z.boolean().optional().describe("Create the item inactive (default: ConnectWise's default, active)"),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true for the item to be created. Omitted or false makes no write"),
    },
    SETUP_CREATE,
    async ({ boardId, name, inactiveFlag, confirm }) => {
      const items = await fetchAllPages<CwRecord>(client, `/service/boards/${boardId}/items`);
      const clash = items.filter(
        (item) => typeof item.name === "string" && item.name.trim().toLowerCase() === name.toLowerCase(),
      );
      if (clash.length > 0) {
        return {
          content: [
            text({
              created: false,
              alreadyPresent: true,
              message: "An item with this name is already on the board. Nothing was changed.",
              boardId,
              existing: clash.map(toItemImage),
            }),
          ],
        };
      }

      const body: CwRecord = { name, ...(inactiveFlag === undefined ? {} : { inactiveFlag }) };
      if (confirm !== true) {
        return {
          content: [
            text({
              created: false,
              message: NO_WRITE,
              boardId,
              before: { itemCount: items.length },
              planned: { create: body },
            }),
          ],
          isError: true,
        };
      }

      const made = asRecord(await client.post(`/service/boards/${boardId}/items`, body));
      const newId = typeof made?.id === "number" ? made.id : null;
      const readBack =
        newId === null ? null : await client.get<CwRecord>(`/service/boards/${boardId}/items/${newId}`);
      const after = readBack ? toItemImage(readBack) : null;
      const verified =
        after !== null &&
        after.name === name &&
        (inactiveFlag === undefined || after.inactiveFlag === inactiveFlag);
      return {
        content: [
          text({
            created: after !== null,
            verified,
            boardId,
            before: { itemCount: items.length },
            after,
          }),
        ],
        isError: !verified,
      };
    },
  );

  server.tool(
    "cw_update_board_item",
    "Change the name or inactiveFlag of one item on a service board (PATCH /service/boards/{id}/items/{itemId}). Only those two fields can be changed. The item is read first and a request that changes nothing is reported with nothing written. An item that is not on the named board is refused. Requires confirm: true. Without it nothing is written and the plan is returned with the before-image. After the write the item is read back and each changed field compared. There is no delete tool for items.",
    {
      boardId: z.number().int().positive().describe("Service board ID"),
      itemId: z.number().int().positive().describe("Board item ID, from cw_list_board_items"),
      name: z.string().trim().min(1).max(50).optional().describe("New item name"),
      inactiveFlag: z.boolean().optional().describe("true switches the item off, false switches it on"),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true for the item to be changed. Omitted or false makes no write"),
    },
    SETUP_UPDATE,
    async ({ boardId, itemId, name, inactiveFlag, confirm }) => {
      if (name === undefined && inactiveFlag === undefined) {
        return {
          content: [text({ updated: false, refused: true, message: "Pass name, inactiveFlag or both.", boardId, itemId })],
          isError: true,
        };
      }
      const path = `/service/boards/${boardId}/items/${itemId}`;
      const before = toItemImage(await client.get<CwRecord>(path));
      if (before.boardId !== null && before.boardId !== boardId) {
        return {
          content: [
            text({ updated: false, refused: true, message: `Item ${itemId} is on board ${before.boardId}, not board ${boardId}. Nothing was changed.`, before }),
          ],
          isError: true,
        };
      }

      const operations: Array<{ op: "replace"; path: string; value: unknown }> = [];
      if (name !== undefined && name !== before.name) operations.push({ op: "replace", path: "/name", value: name });
      if (inactiveFlag !== undefined && inactiveFlag !== before.inactiveFlag) {
        operations.push({ op: "replace", path: "/inactiveFlag", value: inactiveFlag });
      }
      if (operations.length === 0) {
        return {
          content: [text({ updated: false, noChange: true, message: "The item already has these values. Nothing was changed.", boardId, before })],
        };
      }
      if (confirm !== true) {
        return {
          content: [text({ updated: false, message: NO_WRITE, boardId, before, planned: { operations } })],
          isError: true,
        };
      }

      await client.patch(path, operations);
      const after = toItemImage(await client.get<CwRecord>(path));
      const mismatches = operations
        .map((op) => ({ field: op.path.slice(1), wanted: op.value, found: after[op.path.slice(1)] }))
        .filter((entry) => entry.wanted !== entry.found);
      return {
        content: [text({ updated: true, verified: mismatches.length === 0, mismatches, boardId, before, after })],
        isError: mismatches.length > 0,
      };
    },
  );

  server.tool(
    "cw_update_board_subtype",
    "Change one subtype on a service board (PATCH /service/boards/{id}/subtypes/{subtypeId}): its name, its inactiveFlag, and the types it is linked to. Link changes are given as addTypeIds and removeTypeIds, which are applied to the subtype's current typeAssociationIds and sent as the full resulting list. Every type id to add must be a type on this board (read from /types), and an id cannot be in both lists. The subtype is read first and a request that changes nothing is reported with nothing written. A subtype that is not on the named board is refused. Requires confirm: true. Without it nothing is written and the plan is returned with the before-image. After the write the subtype is read back and each changed field compared, and a link change ConnectWise did not keep is reported as a mismatch, not as done. Removing a type link can change which items appear for that type: read cw_list_board_item_associations first. There is no delete tool for subtypes.",
    {
      boardId: z.number().int().positive().describe("Service board ID"),
      subtypeId: z.number().int().positive().describe("Board subtype ID, from cw_list_board_types"),
      name: z.string().trim().min(1).max(50).optional().describe("New subtype name"),
      inactiveFlag: z.boolean().optional().describe("true switches the subtype off, false switches it on"),
      addTypeIds: z.array(z.number().int().positive()).max(100).optional().describe("Type IDs to link to this subtype"),
      removeTypeIds: z.array(z.number().int().positive()).max(100).optional().describe("Type IDs to unlink from this subtype"),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true for the subtype to be changed. Omitted or false makes no write"),
    },
    SETUP_UPDATE_LINKS,
    async ({ boardId, subtypeId, name, inactiveFlag, addTypeIds, removeTypeIds, confirm }) => {
      const refuse = (message: string, extra: CwRecord = {}) => ({
        content: [text({ updated: false, refused: true, message, boardId, subtypeId, ...extra })],
        isError: true,
      });
      const add = [...new Set(addTypeIds ?? [])];
      const remove = [...new Set(removeTypeIds ?? [])];
      if (name === undefined && inactiveFlag === undefined && add.length === 0 && remove.length === 0) {
        return refuse("Pass name, inactiveFlag, addTypeIds, removeTypeIds or a combination.");
      }
      const both = add.filter((id) => remove.includes(id));
      if (both.length > 0) return refuse(`Type ids ${both.join(", ")} are in both addTypeIds and removeTypeIds.`);

      const path = `/service/boards/${boardId}/subtypes/${subtypeId}`;
      const before = toSubtypeImage(await client.get<CwRecord>(path));
      if (before.boardId !== null && before.boardId !== boardId) {
        return refuse(`Subtype ${subtypeId} is on board ${before.boardId}, not board ${boardId}. Nothing was changed.`, { before });
      }

      if (add.length > 0) {
        const boardTypes = await fetchAllPages<CwRecord>(client, `/service/boards/${boardId}/types`);
        const known = new Set(boardTypes.map((type) => type.id));
        const unknown = add.filter((id) => !known.has(id));
        if (unknown.length > 0) {
          return refuse(`Type ids ${unknown.join(", ")} are not types on board ${boardId}. Nothing was changed.`, { before });
        }
      }

      const currentLinks = before.typeAssociationIds as number[];
      const wantedLinks = [...new Set([...currentLinks, ...add])].filter((id) => !remove.includes(id));
      const operations: Array<{ op: "replace"; path: string; value: unknown }> = [];
      if (name !== undefined && name !== before.name) operations.push({ op: "replace", path: "/name", value: name });
      if (inactiveFlag !== undefined && inactiveFlag !== before.inactiveFlag) {
        operations.push({ op: "replace", path: "/inactiveFlag", value: inactiveFlag });
      }
      const linksChange = (add.length > 0 || remove.length > 0) && !sameIds(currentLinks, wantedLinks);
      if (linksChange) operations.push({ op: "replace", path: "/typeAssociationIds", value: wantedLinks });

      if (operations.length === 0) {
        return {
          content: [text({ updated: false, noChange: true, message: "The subtype already has these values. Nothing was changed.", boardId, before })],
        };
      }
      if (confirm !== true) {
        return {
          content: [text({ updated: false, message: NO_WRITE, boardId, before, planned: { operations } })],
          isError: true,
        };
      }

      await client.patch(path, operations);
      const after = toSubtypeImage(await client.get<CwRecord>(path));
      const mismatches = operations
        .map((op) => {
          const field = op.path.slice(1);
          return { field, wanted: op.value, found: after[field] };
        })
        .filter((entry) =>
          entry.field === "typeAssociationIds"
            ? !sameIds(entry.wanted as number[], entry.found as number[])
            : entry.wanted !== entry.found,
        );
      return {
        content: [text({ updated: true, verified: mismatches.length === 0, mismatches, boardId, before, after })],
        isError: mismatches.length > 0,
      };
    },
  );
}

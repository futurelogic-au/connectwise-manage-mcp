import { z } from "zod";

/**
 * Lean ticket shape and patch verification, shared by cw_get_ticket,
 * cw_update_ticket and cw_bulk_update_tickets.
 *
 * A full Manage ticket carries around 80 fields plus a nested record for every
 * reference, so a single update response is a large share of a caller's
 * context. The lean shape keeps what a caller needs to confirm a change:
 * id, summary, board, status, owner, company and _info.lastUpdated.
 */

/** A Manage reference reduced to its id and the labels a person reads. */
export interface LeanRef {
  id: number | null;
  name: string | null;
  identifier?: string;
}

/** The lean shape every lean ticket response returns. Every key is always present. */
export interface LeanTicket {
  id: number | null;
  summary: string | null;
  board: LeanRef | null;
  status: LeanRef | null;
  owner: LeanRef | null;
  company: LeanRef | null;
  _info: { lastUpdated: string | null };
}

function leanRef(ref: unknown): LeanRef | null {
  if (!ref || typeof ref !== "object") return null;
  const record = ref as { id?: unknown; name?: unknown; identifier?: unknown };
  const lean: LeanRef = {
    id: typeof record.id === "number" ? record.id : null,
    name: typeof record.name === "string" ? record.name : null,
  };
  if (typeof record.identifier === "string" && record.identifier) {
    lean.identifier = record.identifier;
  }
  return lean;
}

/** Reduce a Manage ticket to the lean shape, with stable keys. */
export function toLeanTicket(ticket: unknown): LeanTicket {
  const record = (ticket && typeof ticket === "object" ? ticket : {}) as Record<string, unknown>;
  const info = (record._info && typeof record._info === "object" ? record._info : {}) as {
    lastUpdated?: unknown;
  };
  return {
    id: typeof record.id === "number" ? record.id : null,
    summary: typeof record.summary === "string" ? record.summary : null,
    board: leanRef(record.board),
    status: leanRef(record.status),
    owner: leanRef(record.owner),
    company: leanRef(record.company),
    _info: { lastUpdated: typeof info.lastUpdated === "string" ? info.lastUpdated : null },
  };
}

/** One JSON Patch operation, as cw_update_ticket and cw_bulk_update_tickets accept it. */
export const ticketPatchOperationSchema = z.object({
  op: z.enum(["replace", "add", "remove"]).describe("Patch operation"),
  path: z.string().describe("JSON path (e.g. 'status/id', 'summary')"),
  value: z.unknown().optional().describe("New value"),
});

export type TicketPatchOperation = z.infer<typeof ticketPatchOperationSchema>;

/** Walk a slash path into a record. Returns found: false when a segment is missing. */
function readPath(record: unknown, path: string): { found: boolean; value: unknown } {
  const segments = path.split("/").filter((segment) => segment !== "");
  let cursor: unknown = record;
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== "object") return { found: false, value: undefined };
    cursor = (cursor as Record<string, unknown>)[segment];
    if (cursor === undefined) return { found: false, value: undefined };
  }
  return { found: true, value: cursor };
}

/** True when `actual` holds `expected`. An expected object matches on the keys it names. */
function holds(expected: unknown, actual: unknown): boolean {
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
    if (actual === null || typeof actual !== "object") return false;
    return Object.entries(expected as Record<string, unknown>).every(([key, value]) =>
      holds(value, (actual as Record<string, unknown>)[key]),
    );
  }
  return JSON.stringify(expected) === JSON.stringify(actual);
}

export interface PatchCheck {
  /** Paths whose value on the fresh read is not the value that was sent. */
  mismatches: string[];
  /** Paths the fresh read has no matching field for, so the check cannot judge them. */
  unchecked: string[];
}

/**
 * Compare a patch with a fresh read of the record. A path the record does not
 * carry is reported as unchecked, never as a pass.
 */
export function checkPatchAgainstRecord(
  record: unknown,
  operations: TicketPatchOperation[],
): PatchCheck {
  const mismatches: string[] = [];
  const unchecked: string[] = [];
  for (const operation of operations) {
    const read = readPath(record, operation.path);
    if (operation.op === "remove") {
      // A removed field reads back as absent or null.
      if (read.found && read.value !== null) mismatches.push(operation.path);
      continue;
    }
    if (!read.found) {
      unchecked.push(operation.path);
      continue;
    }
    if (!holds(operation.value, read.value)) mismatches.push(operation.path);
  }
  return { mismatches, unchecked };
}

/** Names the operations that RFC 6902 says need a value but carry none. */
export function operationsMissingValue(operations: TicketPatchOperation[]): string[] {
  return operations
    .filter((operation) => operation.op !== "remove" && operation.value === undefined)
    .map((operation) => operation.path);
}

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient } from "../api-client.js";
import { buildMultipart } from "../multipart.js";
import { fetchAllPages } from "./paging.js";

/**
 * Expense claims and receipts (rulings D22 to D24).
 *
 * - Own claims only (D23). The member is never a free choice: it is the
 *   member id in CW_MANAGE_MEMBER_ID, set per person in that person's own
 *   connector entry. Unset, the expense tools refuse. (GET /system/myAccount
 *   answers 404 on ConnectWise v2025.1, so it is not used anywhere.)
 * - The expense type is a required parameter, with no default. Every claim
 *   needs a charge-to: exactly one of chargeCodeId or companyId, with no
 *   default (D22, amended 12/10/2026). A charge code goes as chargeToType
 *   ChargeCode with chargeToId. A company goes as the entry's company
 *   reference, which is what ConnectWise's expense entry model asks for when
 *   there is no charge-to type.
 * - Create needs confirm: true, and a duplicate check on date, amount and
 *   merchant runs first (D24). There is no delete tool.
 * - A receipt is read from disk and uploaded. It is never moved, renamed or
 *   filed. The file must sit under the folder named in CW_MANAGE_ATTACH_ROOT.
 */

/** Largest receipt the tool will send. ConnectWise's own cap is not published. */
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

const RECEIPT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

const READ_ONLY = { readOnlyHint: true };
const ADDITIVE = { readOnlyHint: false, destructiveHint: false };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function text(value: unknown) {
  return { type: "text" as const, text: JSON.stringify(value, null, 2) };
}

function refused(message: string, extra: Record<string, unknown> = {}) {
  return { content: [text({ saved: false, refused: true, message, ...extra })], isError: true };
}

interface Ref {
  id?: number;
  name?: string;
  identifier?: string;
}

interface ExpenseRecord {
  id?: number;
  date?: string;
  amount?: number;
  notes?: string | null;
  status?: string;
  chargeToType?: string | null;
  chargeToId?: number | null;
  billableOption?: string | null;
  member?: Ref | null;
  type?: Ref | null;
  company?: Ref | null;
  expenseReport?: Ref | null;
}

function leanExpense(record: ExpenseRecord) {
  return {
    id: typeof record.id === "number" ? record.id : null,
    date: typeof record.date === "string" ? record.date : null,
    amount: typeof record.amount === "number" ? record.amount : null,
    type: record.type ? { id: record.type.id ?? null, name: record.type.name ?? null } : null,
    notes: record.notes ?? null,
    status: record.status ?? null,
    chargeToType: record.chargeToType ?? null,
    chargeToId: record.chargeToId ?? null,
    company: record.company ? { id: record.company.id ?? null, name: record.company.name ?? null } : null,
    billableOption: record.billableOption ?? null,
    expenseReportId: record.expenseReport?.id ?? null,
    memberId: record.member?.id ?? null,
  };
}

/** The Perth (UTC+8) calendar date of an instant, as YYYY-MM-DD. */
function perthDate(iso: string): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return iso.slice(0, 10);
  return new Date(instant.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** True when an expense entry's date is the given calendar date, read as UTC or as Perth. */
function onDate(entryDate: string | undefined, date: string): boolean {
  if (!entryDate) return false;
  return entryDate.slice(0, 10) === date || perthDate(entryDate) === date;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The environment variable that names the owner's own ConnectWise member id. */
export const MEMBER_ID_VARIABLE = "CW_MANAGE_MEMBER_ID";

/**
 * The owner's own member id, from CW_MANAGE_MEMBER_ID. Returns a plain message,
 * never a throw, when it is unset or not a whole number above zero, so a tool
 * can refuse with it and read and write nothing.
 */
export function ownMemberId(): { id: number } | { message: string } {
  const raw = typeof process !== "undefined" ? process.env[MEMBER_ID_VARIABLE] : undefined;
  const value = raw?.trim();
  if (!value) {
    return {
      message: `The expense tools need ${MEMBER_ID_VARIABLE}, the owner's own ConnectWise member id, set in the connector entry. It is not set, so nothing was read or changed (D23).`,
    };
  }
  if (!/^[1-9]\d*$/.test(value)) {
    return {
      message: `${MEMBER_ID_VARIABLE} must be a whole number above zero, the owner's own ConnectWise member id. Nothing was read or changed (D23).`,
    };
  }
  return { id: Number(value) };
}

export interface DuplicateCheck {
  /** Same member, same date, same amount, and the merchant appears in the notes. */
  duplicates: ExpenseRecord[];
  /** Same member, same date, same amount, but the notes do not name the merchant. */
  similar: ExpenseRecord[];
}

/** Look for a claim already made for this date, amount and merchant. */
export async function checkDuplicates(
  client: CwManageClient,
  input: { memberId: number; date: string; amount: number; merchant: string },
): Promise<DuplicateCheck> {
  const from = addDays(input.date, -1);
  const to = addDays(input.date, 2);
  const entries = await fetchAllPages<ExpenseRecord>(client, "/expense/entries", {
    conditions: `member/id = ${input.memberId} and date >= [${from}T00:00:00Z] and date < [${to}T00:00:00Z]`,
  });
  const merchant = input.merchant.trim().toLowerCase();
  const sameDay = entries.filter(
    (entry) =>
      typeof entry.amount === "number" &&
      Math.abs(entry.amount - input.amount) < 0.005 &&
      onDate(entry.date, input.date),
  );
  return {
    duplicates: sameDay.filter((entry) => (entry.notes ?? "").toLowerCase().includes(merchant)),
    similar: sameDay.filter((entry) => !(entry.notes ?? "").toLowerCase().includes(merchant)),
  };
}

export function registerExpenseTools(server: McpServer, client: CwManageClient) {
  server.tool(
    "cw_list_expense_types",
    "List expense types (GET /expense/types), with the ID that cw_create_expense_entry needs as expenseTypeId. Inactive types are left out unless includeInactive is true. Read-only.",
    {
      includeInactive: z.boolean().optional().describe("Include inactive types (default: false)"),
    },
    READ_ONLY,
    async ({ includeInactive }) => {
      const types = await fetchAllPages<Record<string, unknown>>(client, "/expense/types");
      const rows = types
        .filter((type) => includeInactive === true || type.inactiveFlag !== true)
        .map((type) => ({
          id: typeof type.id === "number" ? type.id : null,
          name: typeof type.name === "string" ? type.name : null,
          mileage: type.mileageFlag === true,
          billExpenses: typeof type.billExpenses === "string" ? type.billExpenses : null,
          inactive: type.inactiveFlag === true,
        }));
      return { content: [text({ count: rows.length, types: rows })] };
    },
  );

  server.tool(
    "cw_list_charge_codes",
    "List charge codes (GET /time/chargeCodes), with the ID that cw_create_expense_entry takes as chargeCodeId. Read-only.",
    {},
    READ_ONLY,
    async () => {
      const codes = await fetchAllPages<Record<string, unknown>>(client, "/time/chargeCodes");
      const rows = codes.map((code) => ({
        id: typeof code.id === "number" ? code.id : null,
        name: typeof code.name === "string" ? code.name : null,
      }));
      return { content: [text({ count: rows.length, chargeCodes: rows })] };
    },
  );

  server.tool(
    "cw_search_expense_entries",
    "Search the owner's own expense entries (GET /expense/entries). Own claims only: the member is the owner's member id from the CW_MANAGE_MEMBER_ID environment variable, a different memberId is refused, and with the variable unset nothing is read. Filter by dateFrom and dateTo (YYYY-MM-DD) and amount. Each row is lean: id, date, amount, type, notes, status, chargeToType, chargeToId, company, billableOption, expenseReportId and memberId. Read-only.",
    {
      memberId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Must be the owner's own member ID, or omitted. Any other member is refused"),
      dateFrom: z.string().regex(DATE_PATTERN).optional().describe("First date, YYYY-MM-DD"),
      dateTo: z.string().regex(DATE_PATTERN).optional().describe("Last date, YYYY-MM-DD"),
      amount: z.number().nonnegative().optional().describe("Exact amount"),
      page: z.number().int().positive().optional().describe("Page number (default: 1)"),
      pageSize: z.number().int().positive().max(1000).optional().describe("Results per page (default: 25)"),
    },
    READ_ONLY,
    async ({ memberId, dateFrom, dateTo, amount, page, pageSize }) => {
      const member = ownMemberId();
      if ("message" in member) return refused(member.message);
      const own = member.id;
      if (memberId !== undefined && memberId !== own) {
        return refused(
          `Expense claims are limited to the owner's own (D23). Member ${memberId} is not the member in ${MEMBER_ID_VARIABLE}. Nothing was read.`,
        );
      }
      const parts = [`member/id = ${own}`];
      if (dateFrom) parts.push(`date >= [${dateFrom}T00:00:00Z]`);
      if (dateTo) parts.push(`date < [${addDays(dateTo, 1)}T00:00:00Z]`);
      if (amount !== undefined) parts.push(`amount = ${amount}`);

      const entries = await client.get<ExpenseRecord[]>("/expense/entries", {
        conditions: parts.join(" and "),
        page: page ?? 1,
        pageSize: pageSize ?? 25,
        orderBy: "date desc",
      });
      const rows = (Array.isArray(entries) ? entries : []).map(leanExpense);
      return { content: [text({ memberId: own, count: rows.length, entries: rows })] };
    },
  );

  server.tool(
    "cw_create_expense_entry",
    "Create one expense entry for the owner (POST /expense/entries). Own claims only: the member is the id in CW_MANAGE_MEMBER_ID, and with it unset nothing is written. expenseTypeId is required and has no default: read it with cw_list_expense_types. Every claim needs a charge-to: pass exactly one of chargeCodeId (from cw_list_charge_codes) and companyId, with no default. Neither, or both, is refused and nothing is written. The merchant is required and is written at the start of the notes, because an expense entry has no merchant field: notes of 'Petrol' for the merchant 'Ampol' are stored as 'Ampol, Petrol'. A duplicate check runs first on the owner's entries for the same date, same amount and a note naming the same merchant: a match is refused and nothing is written. Requires confirm: true. Without it nothing is written and the plan, with the duplicate check, is returned. After the write the entry is read back. There is no delete tool: a claim made in error is removed by hand in ConnectWise.",
    {
      expenseTypeId: z.number().int().positive().describe("Expense type ID, from cw_list_expense_types. Required, no default"),
      chargeCodeId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Charge code ID, from cw_list_charge_codes. Pass this or companyId, not both"),
      companyId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Company ID to charge the claim to. Pass this or chargeCodeId, not both"),
      amount: z.number().positive().describe("Amount claimed, in dollars"),
      date: z.string().regex(DATE_PATTERN).describe("Date of the expense, YYYY-MM-DD"),
      merchant: z.string().trim().min(2).describe("Who was paid. Used for the duplicate check and written into the notes"),
      notes: z.string().optional().describe("Notes. The merchant is put in front if the notes do not already name it"),
      paymentMethodId: z.number().int().positive().optional().describe("Payment method ID"),
      billableOption: z
        .enum(["Billable", "DoNotBill", "NoCharge", "NoDefault"])
        .optional()
        .describe("How the expense bills. Omit to let ConnectWise decide"),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true for the claim to be created. Omitted or false makes no write"),
    },
    ADDITIVE,
    async ({
      expenseTypeId,
      chargeCodeId,
      companyId,
      amount,
      date,
      merchant,
      notes,
      paymentMethodId,
      billableOption,
      confirm,
    }) => {
      // Every claim needs a charge-to: exactly one of a charge code or a company.
      if ((chargeCodeId === undefined) === (companyId === undefined)) {
        return refused(
          chargeCodeId === undefined
            ? "A claim needs a charge-to. Pass exactly one of chargeCodeId and companyId. Nothing was written."
            : "Pass exactly one of chargeCodeId and companyId, not both. Nothing was written.",
        );
      }

      const member = ownMemberId();
      if ("message" in member) return refused(member.message);
      const own = member.id;

      const noteText =
        notes && notes.toLowerCase().includes(merchant.toLowerCase()) ? notes : notes ? `${merchant}, ${notes}` : merchant;
      const body: Record<string, unknown> = {
        member: { id: own },
        type: { id: expenseTypeId },
        amount,
        date: `${date}T00:00:00Z`,
        notes: noteText,
      };
      if (chargeCodeId !== undefined) {
        body.chargeToType = "ChargeCode";
        body.chargeToId = chargeCodeId;
      } else {
        // No charge-to type: the entry's company reference is the charge-to.
        body.company = { id: companyId };
      }
      if (paymentMethodId !== undefined) body.paymentMethod = { id: paymentMethodId };
      if (billableOption !== undefined) body.billableOption = billableOption;

      const check = await checkDuplicates(client, { memberId: own, date, amount, merchant });
      if (check.duplicates.length > 0) {
        return refused(
          `A claim for ${amount} on ${date} naming ${merchant} already exists (entry ${check.duplicates
            .map((d) => d.id)
            .join(", ")}). Nothing was written.`,
          { duplicates: check.duplicates.map(leanExpense), similar: check.similar.map(leanExpense) },
        );
      }

      if (confirm !== true) {
        return {
          content: [
            text({
              saved: false,
              message: "No write was made. Pass confirm: true to create this claim.",
              planned: body,
              duplicateCheck: {
                duplicates: [],
                similar: check.similar.map(leanExpense),
                note:
                  check.similar.length > 0
                    ? "An entry exists for the same date and amount but its notes do not name this merchant. Check it is not the same claim."
                    : "No entry for the same date and amount.",
              },
            }),
          ],
          isError: true,
        };
      }

      const created = await client.post<ExpenseRecord>("/expense/entries", body);
      const id = typeof created?.id === "number" ? created.id : undefined;
      if (id === undefined) {
        return {
          content: [
            text({
              saved: true,
              verified: false,
              message: "ConnectWise did not return an entry id, so the claim could not be read back. Check ConnectWise before trying again.",
            }),
          ],
          isError: true,
        };
      }

      const fresh = await client.get<ExpenseRecord>(`/expense/entries/${id}`);
      const mismatches: string[] = [];
      if (typeof fresh.amount !== "number" || Math.abs(fresh.amount - amount) >= 0.005) mismatches.push("amount");
      if (fresh.type?.id !== expenseTypeId) mismatches.push("type");
      if (chargeCodeId !== undefined && fresh.chargeToId !== chargeCodeId) mismatches.push("chargeCode");
      if (companyId !== undefined && fresh.company?.id !== companyId) mismatches.push("company");
      if (fresh.member?.id !== own) mismatches.push("member");
      if (!onDate(fresh.date, date)) mismatches.push("date");
      const verified = mismatches.length === 0;
      return {
        content: [
          text({
            saved: true,
            verified,
            ...(verified ? {} : { mismatches }),
            entry: leanExpense(fresh),
          }),
        ],
        isError: !verified,
      };
    },
  );

  server.tool(
    "cw_attach_document",
    `Attach a receipt to one of the owner's expense entries (POST /system/documents, multipart). Own claims only: the entry must belong to the member id in CW_MANAGE_MEMBER_ID. The file is read from disk and never moved, renamed or filed. It must be a .pdf, .png, .jpg or .jpeg of at most ${MAX_RECEIPT_BYTES / (1024 * 1024)} MiB, and it must sit under the folder named in the CW_MANAGE_ATTACH_ROOT environment variable. Without that variable nothing is attached. A file already on the entry with the same name and size is not attached twice. If ConnectWise answers an upload with a document that was already on the entry, the response says attached: false and names that document. Requires confirm: true. Without it nothing is written and the file's name, size and SHA-256 are returned. After the upload the entry's documents are read back.`,
    {
      recordType: z.enum(["Expense"]).describe("What the document attaches to. Only Expense is supported"),
      recordId: z.number().int().positive().describe("Expense entry ID, from cw_create_expense_entry"),
      filePath: z.string().min(1).describe("Absolute path of the receipt file, under CW_MANAGE_ATTACH_ROOT"),
      title: z.string().min(1).optional().describe("Document title. Default: the file name"),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true for the upload to happen. Omitted or false makes no write"),
    },
    ADDITIVE,
    async ({ recordType, recordId, filePath, title, confirm }) => {
      const root = typeof process !== "undefined" ? process.env.CW_MANAGE_ATTACH_ROOT : undefined;
      if (!root) {
        return refused(
          "Receipts can be attached only from a folder named in the CW_MANAGE_ATTACH_ROOT environment variable, and it is not set. Nothing was read.",
        );
      }

      const member = ownMemberId();
      if ("message" in member) return refused(member.message);
      const own = member.id;

      let fs: typeof import("node:fs/promises");
      let nodePath: typeof import("node:path");
      try {
        fs = await import("node:fs/promises");
        nodePath = await import("node:path");
      } catch {
        return refused("This runtime has no file system, so a receipt cannot be read. Nothing was changed.");
      }

      // The file must be a regular file under the allowed root, by its real path.
      let realFile: string;
      let realRoot: string;
      try {
        realRoot = await fs.realpath(root);
        realFile = await fs.realpath(filePath);
      } catch {
        return refused("The receipt file or the attach folder could not be found. Nothing was changed.");
      }
      const relative = nodePath.relative(realRoot, realFile);
      if (relative === "" || relative.startsWith("..") || nodePath.isAbsolute(relative)) {
        return refused("The receipt is not under the folder named in CW_MANAGE_ATTACH_ROOT. Nothing was read.");
      }
      const extension = nodePath.extname(realFile).toLowerCase();
      const contentType = RECEIPT_TYPES[extension];
      if (!contentType) {
        return refused(`A ${extension || "file with no extension"} is not an accepted receipt type. Use .pdf, .png, .jpg or .jpeg.`);
      }
      const stat = await fs.stat(realFile);
      if (!stat.isFile()) return refused("The receipt path is not a file. Nothing was changed.");
      if (stat.size === 0) return refused("The receipt file is empty. Nothing was changed.");
      if (stat.size > MAX_RECEIPT_BYTES) {
        return refused(
          `The receipt is ${stat.size} bytes, over the ${MAX_RECEIPT_BYTES} byte limit this tool sends. Nothing was changed.`,
        );
      }

      const data = new Uint8Array(await fs.readFile(realFile));
      if (extension === ".pdf" && new TextDecoder().decode(data.subarray(0, 5)) !== "%PDF-") {
        return refused("The file has a .pdf name but is not a PDF. Nothing was changed.");
      }
      const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
      const sha256 = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const fileName = nodePath.basename(realFile);

      // Own claims only.
      const entry = await client.get<ExpenseRecord>(`/expense/entries/${recordId}`);
      if (entry.member?.id !== own) {
        return refused(
          `Expense entry ${recordId} is not the owner's own claim (D23). Nothing was changed.`,
        );
      }

      const existing = await client.get<Array<Record<string, unknown>>>("/system/documents", {
        recordType,
        recordId,
        pageSize: 100,
      });
      const existingDocs = Array.isArray(existing) ? existing : [];
      const already = existingDocs.find((doc) => doc.fileName === fileName && doc.fileSize === stat.size);
      if (already) {
        return {
          content: [
            text({
              attached: false,
              alreadyPresent: true,
              message: "A document with this name and size is already on the entry. Nothing was changed.",
              document: { id: already.id ?? null, fileName, fileSize: stat.size },
            }),
          ],
        };
      }
      // Ids on the entry before the upload. A document id that comes back from the upload
      // and is in this set was not created by it.
      const priorIds = new Set(
        existingDocs.map((doc) => doc.id).filter((value): value is number => typeof value === "number"),
      );

      const plan = { recordType, recordId, fileName, fileSize: stat.size, contentType, sha256, title: title ?? fileName };
      if (confirm !== true) {
        return {
          content: [
            text({ attached: false, message: "No write was made. Pass confirm: true to attach this file.", planned: plan }),
          ],
          isError: true,
        };
      }

      const multipart = buildMultipart(
        {
          recordType,
          recordId: String(recordId),
          Title: title ?? fileName,
          PrivateFlag: "true",
          ReadOnlyFlag: "false",
          isAvatar: "false",
        },
        { fieldName: "file", fileName, contentType, data },
      );
      const created = await client.postMultipart<Record<string, unknown>>("/system/documents", multipart);
      const documentId = typeof created?.id === "number" ? created.id : undefined;

      const after = await client.get<Array<Record<string, unknown>>>("/system/documents", {
        recordType,
        recordId,
        pageSize: 100,
      });
      const afterDocs = Array.isArray(after) ? after : [];

      // ConnectWise answered with a document that was already on the entry. Nothing new was
      // added, so say that and name the document, not "attached".
      if (documentId !== undefined && priorIds.has(documentId)) {
        const prior = afterDocs.find((doc) => doc.id === documentId) ?? existingDocs.find((doc) => doc.id === documentId);
        return {
          content: [
            text({
              attached: false,
              alreadyPresent: true,
              message: `ConnectWise answered with document ${documentId}, which was already on the entry before this call. No new document was added.`,
              document: {
                id: documentId,
                title: prior?.title ?? null,
                fileName: prior?.fileName ?? null,
                fileSize: prior?.fileSize ?? null,
              },
            }),
          ],
        };
      }

      // The new document is the one with the id the upload returned. A file name alone can
      // match an older document of the same name, so it is used only when no id came back,
      // and then only among documents that were not on the entry before.
      const found =
        documentId !== undefined
          ? afterDocs.find((doc) => doc.id === documentId)
          : afterDocs.find((doc) => doc.fileName === fileName && !priorIds.has(doc.id as number));
      const sizeMatches = found ? found.fileSize === undefined || found.fileSize === stat.size : false;
      const verified = found !== undefined && sizeMatches;
      return {
        content: [
          text({
            attached: true,
            verified,
            ...plan,
            document: found
              ? {
                  id: found.id ?? null,
                  title: found.title ?? null,
                  fileName: found.fileName ?? null,
                  fileSize: found.fileSize ?? null,
                }
              : null,
            ...(verified ? {} : { warning: "The upload was accepted but the entry's documents do not show this file. Check the entry in ConnectWise before trying again." }),
          }),
        ],
        isError: !verified,
      };
    },
  );
}

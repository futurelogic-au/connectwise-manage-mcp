import { CwApiError, CwManageClient } from "../api-client.js";

/**
 * Inactive company handling (ruling D12).
 *
 * ConnectWise refuses to save a service ticket whose company is in a status
 * that does not allow it, with a 400 whose message reads "This company is in a
 * status that does not allow saving Service Ticket". The ticket tools do not
 * pass that message through bare. They name the company and its status, change
 * nothing, and say how to move the ticket: pass a new company with
 * confirm: true.
 */

const INACTIVE_COMPANY_PHRASE = /company is in a status that does not allow saving/i;

/** True when `err` is ConnectWise refusing a save because the company is inactive. */
export function isInactiveCompanyError(err: unknown): boolean {
  return (
    err instanceof CwApiError && err.status === 400 && INACTIVE_COMPANY_PHRASE.test(err.message)
  );
}

/** True when a patch operation changes the ticket's company. */
export function touchesCompany(operations: Array<{ path: string }>): boolean {
  return operations.some((operation) => {
    const first = operation.path.split("/").filter((segment) => segment !== "")[0];
    return first === "company";
  });
}

export interface InactiveCompanyFinding {
  company: { id: number | null; name: string | null; identifier?: string } | null;
  status: { id: number | null; name: string | null } | null;
}

function ref(value: unknown): { id: number | null; name: string | null; identifier?: string } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { id?: unknown; name?: unknown; identifier?: unknown };
  const out: { id: number | null; name: string | null; identifier?: string } = {
    id: typeof record.id === "number" ? record.id : null,
    name: typeof record.name === "string" ? record.name : null,
  };
  if (typeof record.identifier === "string" && record.identifier) out.identifier = record.identifier;
  return out;
}

/**
 * Read the company, and its status, behind a refused save. Either the ticket
 * (an existing ticket) or the company id (a ticket being created) is given.
 * A lookup that fails leaves that part null: the refusal is still returned.
 */
export async function findInactiveCompany(
  client: CwManageClient,
  source: { ticketId?: number; companyId?: number },
): Promise<InactiveCompanyFinding> {
  let companyId = source.companyId;
  let company: InactiveCompanyFinding["company"] = null;

  if (companyId === undefined && source.ticketId !== undefined) {
    try {
      const ticket = await client.get<Record<string, unknown>>(`/service/tickets/${source.ticketId}`);
      company = ref(ticket.company);
      companyId = company?.id ?? undefined;
    } catch {
      /* the refusal below still names what it can */
    }
  }
  if (companyId === undefined) return { company, status: null };

  try {
    const record = await client.get<Record<string, unknown>>(`/company/companies/${companyId}`);
    company = ref(record) ?? company;
    return { company, status: ref(record.status) };
  } catch {
    return { company: company ?? { id: companyId, name: null }, status: null };
  }
}

function label(value: { id: number | null; name: string | null; identifier?: string } | null): string {
  if (!value) return "unknown";
  const name = value.name ?? (value.identifier ? value.identifier : undefined);
  if (name && value.id !== null) return `${name} (id ${value.id})`;
  return name ?? (value.id !== null ? `id ${value.id}` : "unknown");
}

/** The plain message for a save refused because the company is inactive. */
export function inactiveCompanyMessage(
  finding: InactiveCompanyFinding,
  context: { ticketId?: number; verb?: string; remedy?: string },
): string {
  const subject = context.ticketId === undefined ? "The ticket" : `Ticket ${context.ticketId}`;
  const what = context.verb ?? "saved";
  const remedy =
    context.remedy ??
    "To move the ticket to another company, call cw_update_ticket with newCompanyId and confirm: true.";
  return (
    `${subject} was not ${what}. Its company, ${label(finding.company)}, is in the status ` +
    `${finding.status ? `"${finding.status.name ?? `id ${finding.status.id}`}"` : "unknown"}, ` +
    `and ConnectWise does not allow a service ticket to be saved for a company in that status. ` +
    `Nothing was changed. ${remedy}`
  );
}

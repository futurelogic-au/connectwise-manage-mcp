/**
 * Service note write body, per-note email mapping and create-response mapping.
 *
 * Manage API (ServiceNote):
 * - Note type is `detailDescriptionFlag`, `internalAnalysisFlag`, `resolutionFlag`.
 * - `processNotifications` is the ServiceNote field that sends notifications.
 * - ServiceNote has no recipient fields on this ConnectWise version. A POST that
 *   carries `emailContactFlag`, `emailResourceFlag`, `emailCcFlag` or `emailCc`
 *   is refused with 400 "Could not find member ... on object of type
 *   'ServiceNote'". The recipients of a note email come from the ticket's
 *   `automaticEmail*` fields, so a per-note recipient flag is mapped to the
 *   matching ticket field for the one note and put back afterwards.
 * - Nothing is emailed unless the caller sets a recipient flag to true, or sets
 *   `processNotifications` to true. Omitted flags are not sent and are not
 *   defaulted on.
 */

export interface TicketNoteInput {
  text: string;
  detailDescriptionFlag?: boolean;
  internalAnalysisFlag?: boolean;
  resolutionFlag?: boolean;
  customerUpdatedFlag?: boolean;
  emailContactFlag?: boolean;
  emailResourceFlag?: boolean;
  emailCcFlag?: boolean;
  emailCc?: string;
  processNotifications?: boolean;
}

/**
 * The ServiceNote fields that go on the POST body. The recipient fields are
 * absent on purpose: ServiceNote rejects them. See planNoteEmail.
 */
const PASSTHROUGH_KEYS = [
  "detailDescriptionFlag",
  "internalAnalysisFlag",
  "resolutionFlag",
  "customerUpdatedFlag",
  "processNotifications",
] as const satisfies readonly (keyof TicketNoteInput)[];

/** True when the caller set at least one recipient flag to true. */
export function wantsNoteEmail(input: TicketNoteInput): boolean {
  return (
    input.emailContactFlag === true ||
    input.emailResourceFlag === true ||
    input.emailCcFlag === true
  );
}

export function buildTicketNoteBody(input: TicketNoteInput): Record<string, unknown> {
  const body: Record<string, unknown> = { text: input.text };
  for (const key of PASSTHROUGH_KEYS) {
    if (input[key] !== undefined) body[key] = input[key];
  }

  // An explicit processNotifications value wins, including false.
  // Otherwise turn delivery on only when a recipient flag is explicitly true.
  if (input.processNotifications === undefined && wantsNoteEmail(input)) {
    body.processNotifications = true;
  }

  return body;
}

/** The ticket fields that decide who a note email goes to. */
export const TICKET_EMAIL_FIELDS = [
  "automaticEmailContactFlag",
  "automaticEmailResourceFlag",
  "automaticEmailCcFlag",
  "automaticEmailCc",
] as const;

export type TicketEmailField = (typeof TICKET_EMAIL_FIELDS)[number];

export interface TicketEmailOverride {
  field: TicketEmailField;
  /** The value to hold on the ticket while the note is posted. */
  value: boolean | string;
  /** What the ticket holds now, put back after the note is posted. */
  original: boolean | string | null;
}

export interface NoteEmailPlan {
  /** True when ConnectWise will be asked to email for this note. */
  willSend: boolean;
  via: "per-note flags" | "ticket defaults" | "none";
  /** Ticket fields to change for this note, with their original values. */
  overrides: TicketEmailOverride[];
  recipients: { contact: boolean; resources: boolean; cc: string | null };
  /** Why nothing will be sent, when willSend is false. */
  reason?: string;
  /** Reasons to refuse before any write. */
  problems: string[];
}

function ticketString(ticket: Record<string, unknown>, key: string): string {
  const value = ticket[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Work out what a note's recipient flags mean on this ConnectWise version.
 *
 * When any recipient flag is true, the note's recipients are exactly the flags
 * the caller set to true. A recipient the caller did not name is forced off for
 * this note, so a ticket default can never add a person the caller did not ask
 * for. The plan lists the ticket fields to change and what to put back.
 */
export function planNoteEmail(
  input: TicketNoteInput,
  ticket: Record<string, unknown>,
): NoteEmailPlan {
  const none = (reason: string): NoteEmailPlan => ({
    willSend: false,
    via: "none",
    overrides: [],
    recipients: { contact: false, resources: false, cc: null },
    reason,
    problems: [],
  });

  if (input.processNotifications === false) {
    return none("processNotifications was set to false, so ConnectWise sends nothing");
  }

  if (!wantsNoteEmail(input)) {
    if (input.processNotifications === true) {
      return {
        willSend: true,
        via: "ticket defaults",
        overrides: [],
        recipients: {
          contact: ticket.automaticEmailContactFlag === true,
          resources: ticket.automaticEmailResourceFlag === true,
          cc:
            ticket.automaticEmailCcFlag === true
              ? ticketString(ticket, "automaticEmailCc") || null
              : null,
        },
        problems: [],
      };
    }
    return none("no recipient flag was set to true");
  }

  const problems: string[] = [];
  const wantContact = input.emailContactFlag === true;
  const wantResources = input.emailResourceFlag === true;
  const wantCc = input.emailCcFlag === true;

  const ccAddress = wantCc
    ? (input.emailCc?.trim() || ticketString(ticket, "automaticEmailCc"))
    : "";
  if (wantCc && !ccAddress) {
    problems.push("emailCcFlag is true but no address was given in emailCc and the ticket has none");
  }
  const contact = ticket.contact as { id?: unknown } | null | undefined;
  if (wantContact && !(contact && typeof contact === "object" && contact.id != null)) {
    problems.push("emailContactFlag is true but the ticket has no contact");
  }

  const overrides: TicketEmailOverride[] = [];
  const consider = (field: TicketEmailField, value: boolean | string) => {
    const current = ticket[field];
    const original = typeof current === "boolean" || typeof current === "string" ? current : null;
    const same = typeof value === "string" ? (original ?? "") === value : original === value;
    if (!same) overrides.push({ field, value, original });
  };
  consider("automaticEmailContactFlag", wantContact);
  consider("automaticEmailResourceFlag", wantResources);
  consider("automaticEmailCcFlag", wantCc);
  if (wantCc) consider("automaticEmailCc", ccAddress);

  return {
    willSend: problems.length === 0,
    via: "per-note flags",
    overrides,
    recipients: { contact: wantContact, resources: wantResources, cc: wantCc ? ccAddress : null },
    problems,
    ...(problems.length > 0 ? { reason: "the request cannot be sent as given" } : {}),
  };
}

export interface NoteVisibilityRequest {
  detailDescriptionFlag?: boolean;
  internalAnalysisFlag?: boolean;
  resolutionFlag?: boolean;
}

function storedTypeFlag(
  record: Record<string, unknown>,
  key: string,
  requested?: boolean,
): boolean {
  const value = record[key];
  if (typeof value === "boolean") return value;
  return requested === true;
}

/**
 * Manage's note-create response echoes `internalFlag: true` and
 * `externalFlag: true` together, including on notes that were stored as
 * internal-only. A later GET returns both fields as null. Recompute them
 * from the note-type flags that were actually stored so the echo does not
 * claim both visibilities.
 *
 * - internal: `internalAnalysisFlag`
 * - external: discussion (`detailDescriptionFlag`), resolution, or issue
 * - no type flags stored: both null, matching read-back
 */
export function mapCreatedNoteResponse<T>(
  note: T,
  requested?: NoteVisibilityRequest,
): T {
  if (!note || typeof note !== "object" || Array.isArray(note)) return note;
  const record = note as Record<string, unknown>;

  const detail = storedTypeFlag(record, "detailDescriptionFlag", requested?.detailDescriptionFlag);
  const internal = storedTypeFlag(record, "internalAnalysisFlag", requested?.internalAnalysisFlag);
  const resolution = storedTypeFlag(record, "resolutionFlag", requested?.resolutionFlag);
  const issue = storedTypeFlag(record, "issueFlag");

  const typeFlagPresent =
    typeof record.detailDescriptionFlag === "boolean" ||
    typeof record.internalAnalysisFlag === "boolean" ||
    typeof record.resolutionFlag === "boolean" ||
    typeof record.issueFlag === "boolean" ||
    requested?.detailDescriptionFlag !== undefined ||
    requested?.internalAnalysisFlag !== undefined ||
    requested?.resolutionFlag !== undefined;

  if (!typeFlagPresent && !detail && !internal && !resolution && !issue) {
    return { ...record, internalFlag: null, externalFlag: null } as T;
  }

  return {
    ...record,
    internalFlag: internal,
    externalFlag: detail || resolution || issue,
  } as T;
}

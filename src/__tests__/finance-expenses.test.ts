/**
 * Tests for WS3 Group 4, finance: agreement exclusions (D25) and expense claims
 * with a receipt (D22 to D24).
 *
 * The tools are driven through the Worker's MCP endpoint in gateway mode. A
 * small in-test fake stands in for the ConnectWise endpoints the tools call.
 * Test infrastructure only: nothing here is a live ConnectWise result, no test
 * makes a network call, and the receipt files are throw-away temp files.
 */

import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../worker.js";
import { buildMultipart } from "../multipart.js";

const headers = {
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
  "X-CW-Company-Id": "acme",
  "X-CW-Public-Key": "pub",
  "X-CW-Private-Key": "priv",
  "X-CW-Client-Id": "client-guid",
};

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

type Rec = Record<string, unknown>;

async function mcp<T = ToolResult>(method: string, params: unknown): Promise<{ result: T }> {
  const response = await worker.fetch(
    new Request("http://worker.local/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    { AUTH_MODE: "gateway" },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { result: T };
}

async function call(name: string, args: unknown): Promise<ToolResult> {
  return (await mcp("tools/call", { name, arguments: args })).result;
}

function body(result: ToolResult): Rec {
  return JSON.parse(result.content[0].text) as Rec;
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  contentType: string | null;
}

interface World {
  expenseTypes: Rec[];
  chargeCodes: Rec[];
  entries: Rec[];
  documents: Rec[];
  /** Exclusions by agreement id and kind path. */
  exclusions: Record<string, Rec[]>;
  /** Make a created entry come back with a different amount. */
  alterAmount: boolean;
  /** Make a created entry come back without its company. */
  dropCompany: boolean;
  /** Answer an upload of a name already on the record with that document, creating none. */
  dedupeDocuments: boolean;
}

function fakeConnectWise(initial: Partial<World> = {}) {
  const world: World = {
    expenseTypes: [],
    chargeCodes: [],
    entries: [],
    documents: [],
    exclusions: {},
    alterAmount: false,
    dropCompany: false,
    dedupeDocuments: false,
    ...initial,
  };
  const calls: Call[] = [];
  let nextEntry = 900;
  let nextDocument = 1100;
  let nextExclusion = 3000;

  const fetchMock = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const parsed = new URL(String(url));
    const reqPath = parsed.pathname.replace("/v4_6_release/apis/3.0", "");
    const method = String(init.method ?? "GET");
    const reqHeaders = (init.headers ?? {}) as Record<string, string>;
    const contentType = reqHeaders["Content-Type"] ?? null;
    const isBinary = init.body instanceof Uint8Array;
    const payload = init.body && !isBinary ? JSON.parse(String(init.body)) : init.body;
    calls.push({ method, path: reqPath, query: parsed.searchParams, body: payload, contentType });
    let m: RegExpMatchArray | null;

    // ConnectWise v2025.1 answers 404 here. No tool may depend on it.
    if (reqPath === "/system/myAccount") {
      return jsonResponse({ code: "NotFound", message: "Not found" }, 404);
    }
    if (reqPath === "/expense/types") return jsonResponse(world.expenseTypes);
    if (reqPath === "/time/chargeCodes") return jsonResponse(world.chargeCodes);

    if (reqPath === "/expense/entries" && method === "GET") {
      const conditions = parsed.searchParams.get("conditions") ?? "";
      const member = /member\/id = (\d+)/.exec(conditions)?.[1];
      const from = /date >= \[([^\]]+)\]/.exec(conditions)?.[1];
      const to = /date < \[([^\]]+)\]/.exec(conditions)?.[1];
      const amount = /amount = ([\d.]+)/.exec(conditions)?.[1];
      const rows = world.entries.filter((e) => {
        if (member && (e.member as Rec).id !== Number(member)) return false;
        if (from && String(e.date) < from) return false;
        if (to && String(e.date) >= to) return false;
        if (amount && e.amount !== Number(amount)) return false;
        return true;
      });
      return jsonResponse(rows);
    }
    if (reqPath === "/expense/entries" && method === "POST") {
      const record: Rec = { id: nextEntry++, status: "Open", ...(payload as Rec) };
      if (world.alterAmount) record.amount = (record.amount as number) + 1;
      if (world.dropCompany) delete record.company;
      world.entries.push(record);
      return jsonResponse(record);
    }
    if ((m = reqPath.match(/^\/expense\/entries\/(\d+)$/))) {
      const found = world.entries.find((e) => e.id === Number(m![1]));
      return found ? jsonResponse(found) : jsonResponse({ code: "NotFound", message: "Not found" }, 404);
    }

    if (reqPath === "/system/documents" && method === "GET") {
      const recordId = Number(parsed.searchParams.get("recordId"));
      return jsonResponse(world.documents.filter((d) => d.recordId === recordId));
    }
    if (reqPath === "/system/documents" && method === "POST") {
      const text = Buffer.from(payload as Uint8Array).toString("latin1");
      const fileName = /filename="([^"]+)"/.exec(text)?.[1] ?? "";
      const recordId = Number(/name="recordId"\r\n\r\n(\d+)/.exec(text)?.[1]);
      const title = /name="Title"\r\n\r\n([^\r]*)/.exec(text)?.[1] ?? "";
      if (world.dedupeDocuments) {
        const same = world.documents.find((d) => d.recordId === recordId && d.fileName === fileName);
        if (same) return jsonResponse(same);
      }
      const fileSize = (payload as Uint8Array).byteLength; // overwritten below from the file part
      const filePart = text.split(/Content-Type: [^\r]+\r\n\r\n/)[1] ?? "";
      const record: Rec = {
        id: nextDocument++,
        recordId,
        title,
        fileName,
        fileSize: filePart.replace(/\r\n--[^\r]*--\r\n$/, "").length || fileSize,
      };
      world.documents.push(record);
      return jsonResponse(record);
    }

    if ((m = reqPath.match(/^\/finance\/agreements\/(\d+)\/(workroleexclusions|worktypeexclusions)(?:\/(\d+))?$/))) {
      const key = `${m[1]}:${m[2]}`;
      const list = (world.exclusions[key] ??= []);
      if (method === "GET") return jsonResponse(list);
      if (method === "POST") {
        const record = { id: nextExclusion++, ...(payload as Rec) };
        list.push(record);
        return jsonResponse(record);
      }
      if (method === "DELETE") {
        world.exclusions[key] = list.filter((e) => e.id !== Number(m![3]));
        return jsonResponse(undefined, 204);
      }
    }

    return jsonResponse({ code: "NotFound", message: `Unexpected ${method} ${reqPath}` }, 404);
  });

  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock, world };
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("buildMultipart", () => {
  it("writes the fields, then the file bytes, between boundaries", () => {
    const data = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    const out = buildMultipart(
      { recordType: "Expense", recordId: "9" },
      { fieldName: "file", fileName: 'a"b.pdf', contentType: "application/pdf", data },
    );

    const boundary = /boundary=(.+)$/.exec(out.contentType)![1];
    const text = Buffer.from(out.body).toString("latin1");
    expect(text.startsWith(`--${boundary}\r\n`)).toBe(true);
    expect(text.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
    expect(text).toContain('name="recordType"\r\n\r\nExpense\r\n');
    expect(text).toContain('name="file"; filename="a%22b.pdf"');
    expect(text.indexOf("recordId")).toBeLessThan(text.indexOf('name="file"'));
    // The file bytes are in the body unchanged.
    expect(Buffer.from(out.body).includes(Buffer.from(data))).toBe(true);
  });
});

describe("agreement exclusions", () => {
  const roles = { "77:workroleexclusions": [{ id: 11, agreementId: 77, workRole: { id: 5, name: "Engineer" } }] };

  it("lists both kinds, lean, with the exclusion ids", async () => {
    fakeConnectWise({
      exclusions: {
        ...roles,
        "77:worktypeexclusions": [{ id: 12, agreementId: 77, workType: { id: 8, name: "After Hours" } }],
      },
    });
    const result = await call("cw_list_agreement_exclusions", { agreementId: 77 });
    expect(body(result)).toEqual({
      agreementId: 77,
      count: 2,
      exclusions: [
        { exclusionId: 11, kind: "workrole", targetId: 5, targetName: "Engineer" },
        { exclusionId: 12, kind: "worktype", targetId: 8, targetName: "After Hours" },
      ],
    });
  });

  it("is registered read-only for the list, additive for add, destructive for delete", async () => {
    const tools = (await mcp<{ tools: { name: string; annotations?: Rec }[] }>("tools/list", {})).result.tools;
    const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(by.cw_list_agreement_exclusions).toMatchObject({ readOnlyHint: true });
    expect(by.cw_add_agreement_exclusion).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(by.cw_delete_agreement_exclusion).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  describe("add", () => {
    it("needs exactly one of workRoleId and workTypeId", async () => {
      const cw = fakeConnectWise();
      for (const args of [{ agreementId: 77 }, { agreementId: 77, workRoleId: 5, workTypeId: 8 }]) {
        const result = await call("cw_add_agreement_exclusion", { ...args, confirm: true });
        expect(result.isError).toBe(true);
      }
      expect(cw.fetchMock).not.toHaveBeenCalled();
    });

    it("makes no write without confirm: true", async () => {
      const cw = fakeConnectWise();
      const result = await call("cw_add_agreement_exclusion", { agreementId: 77, workTypeId: 8 });
      expect(result.isError).toBe(true);
      expect(body(result)).toMatchObject({
        added: false,
        planned: { kind: "worktype", agreementId: 77, workType: { id: 8 } },
      });
      expect(writes(cw.calls)).toEqual([]);
    });

    it("posts to the right collection and reads the exclusions back", async () => {
      const cw = fakeConnectWise();

      const result = await call("cw_add_agreement_exclusion", { agreementId: 77, workRoleId: 5, confirm: true });

      expect(result.isError).not.toBe(true);
      expect(body(result)).toMatchObject({ added: true, verified: true, exclusion: { kind: "workrole", targetId: 5 } });
      const post = cw.calls.find((c) => c.method === "POST")!;
      expect(post.path).toBe("/finance/agreements/77/workroleexclusions");
      expect(post.body).toEqual({ agreementId: 77, workRole: { id: 5 } });
      expect(cw.calls.at(-1)).toMatchObject({ method: "GET", path: "/finance/agreements/77/workroleexclusions" });
    });

    it("uses the work type collection for a work type", async () => {
      const cw = fakeConnectWise();
      await call("cw_add_agreement_exclusion", { agreementId: 77, workTypeId: 8, confirm: true });
      expect(cw.calls.find((c) => c.method === "POST")!.path).toBe("/finance/agreements/77/worktypeexclusions");
    });

    it("reports an exclusion that is already there and writes nothing", async () => {
      const cw = fakeConnectWise({ exclusions: roles });
      const result = await call("cw_add_agreement_exclusion", { agreementId: 77, workRoleId: 5, confirm: true });
      expect(result.isError).not.toBe(true);
      expect(body(result)).toMatchObject({ added: false, alreadyPresent: true });
      expect(writes(cw.calls)).toEqual([]);
    });
  });

  describe("delete (D25)", () => {
    it("lists first, and makes no write without confirm: true", async () => {
      const cw = fakeConnectWise({ exclusions: roles });
      const result = await call("cw_delete_agreement_exclusion", {
        agreementId: 77,
        kind: "workrole",
        exclusionId: 11,
      });
      expect(result.isError).toBe(true);
      expect(body(result)).toMatchObject({
        deleted: false,
        planned: { exclusionId: 11, targetName: "Engineer" },
      });
      expect(cw.calls.map((c) => c.method)).toEqual(["GET"]);
    });

    it("deletes the one exclusion, after listing, and reads the list back", async () => {
      const cw = fakeConnectWise({ exclusions: roles });

      const result = await call("cw_delete_agreement_exclusion", {
        agreementId: 77,
        kind: "workrole",
        exclusionId: 11,
        confirm: true,
      });

      expect(result.isError).not.toBe(true);
      expect(body(result)).toMatchObject({ deleted: true, verified: true, exclusions: [] });
      expect(cw.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        "GET /finance/agreements/77/workroleexclusions",
        "DELETE /finance/agreements/77/workroleexclusions/11",
        "GET /finance/agreements/77/workroleexclusions",
      ]);
    });

    it("refuses an exclusion that is not on that agreement and deletes nothing", async () => {
      const cw = fakeConnectWise({ exclusions: roles });
      const result = await call("cw_delete_agreement_exclusion", {
        agreementId: 88,
        kind: "workrole",
        exclusionId: 11,
        confirm: true,
      });
      expect(result.isError).toBe(true);
      expect(body(result)).toMatchObject({ deleted: false, refused: true });
      expect(writes(cw.calls)).toEqual([]);
    });
  });
});

describe("expense tools", () => {
  beforeEach(() => {
    vi.stubEnv("CW_MANAGE_MEMBER_ID", "20");
  });

  const types = [
    { id: 3, name: "Fuel", mileageFlag: false, billExpenses: "NoCharge", inactiveFlag: false },
    { id: 4, name: "Old type", inactiveFlag: true },
  ];

  it("lists expense types without the inactive ones, and charge codes", async () => {
    fakeConnectWise({ expenseTypes: types, chargeCodes: [{ id: 12, name: "Internal admin" }] });

    const listed = await call("cw_list_expense_types", {});
    expect((body(listed) as { types: Rec[] }).types).toEqual([
      { id: 3, name: "Fuel", mileage: false, billExpenses: "NoCharge", inactive: false },
    ]);
    const all = await call("cw_list_expense_types", { includeInactive: true });
    expect(body(all).count).toBe(2);

    const codes = await call("cw_list_charge_codes", {});
    expect(body(codes)).toEqual({ count: 1, chargeCodes: [{ id: 12, name: "Internal admin" }] });
  });

  it("has no expense delete tool", async () => {
    const tools = (await mcp<{ tools: { name: string }[] }>("tools/list", {})).result.tools;
    expect(tools.map((t) => t.name).filter((n) => /expense.*(delete|remove)|(delete|remove).*expense/.test(n))).toEqual([]);
  });

  describe("cw_search_expense_entries (D23)", () => {
    const entries = [
      { id: 1, date: "2026-10-05T00:00:00Z", amount: 80.5, member: { id: 20 }, type: { id: 3, name: "Fuel" }, notes: "BP Welshpool" },
      { id: 2, date: "2026-10-06T00:00:00Z", amount: 12, member: { id: 20 }, type: { id: 3, name: "Fuel" }, notes: "Shell" },
      { id: 3, date: "2026-10-05T00:00:00Z", amount: 80.5, member: { id: 99 }, type: { id: 3, name: "Fuel" }, notes: "Someone else" },
    ];

    it("searches only the member the connector runs as", async () => {
      const cw = fakeConnectWise({ entries });

      const result = await call("cw_search_expense_entries", { dateFrom: "2026-10-05", dateTo: "2026-10-05", amount: 80.5 });

      expect((body(result) as { entries: Rec[] }).entries.map((e) => e.id)).toEqual([1]);
      const search = cw.calls.find((c) => c.path === "/expense/entries")!;
      expect(search.query.get("conditions")).toBe(
        "member/id = 20 and date >= [2026-10-05T00:00:00Z] and date < [2026-10-06T00:00:00Z] and amount = 80.5",
      );
    });

    it("refuses another member's id and reads nothing", async () => {
      const cw = fakeConnectWise({ entries });
      const result = await call("cw_search_expense_entries", { memberId: 99 });
      expect(result.isError).toBe(true);
      expect(String(body(result).message)).toMatch(/D23/);
      expect(cw.calls.some((c) => c.path === "/expense/entries")).toBe(false);
    });

    it("returns the company on each lean row, so existing claims can be checked", async () => {
      fakeConnectWise({
        entries: [
          { id: 4, date: "2026-10-05T00:00:00Z", amount: 12, member: { id: 20 }, company: { id: 250, name: "Future Logic HQ" } },
          { id: 5, date: "2026-10-06T00:00:00Z", amount: 9, member: { id: 20 } },
        ],
      });
      const result = await call("cw_search_expense_entries", {});
      const rows = (body(result) as { entries: Rec[] }).entries;
      expect(rows.find((r) => r.id === 4)).toMatchObject({ company: { id: 250, name: "Future Logic HQ" } });
      expect(rows.find((r) => r.id === 5)).toMatchObject({ company: null });
    });

    it("accepts the owner's own member id", async () => {
      fakeConnectWise({ entries });
      const result = await call("cw_search_expense_entries", { memberId: 20 });
      expect(result.isError).not.toBe(true);
      expect(body(result).count).toBe(2);
    });

    it("refuses a member id that differs from CW_MANAGE_MEMBER_ID, without reading", async () => {
      vi.stubEnv("CW_MANAGE_MEMBER_ID", "20");
      const cw = fakeConnectWise({ entries });
      const result = await call("cw_search_expense_entries", { memberId: 21 });
      expect(result.isError).toBe(true);
      expect(String(body(result).message)).toMatch(/not the member in CW_MANAGE_MEMBER_ID/);
      expect(cw.fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("CW_MANAGE_MEMBER_ID", () => {
    const claim = {
      expenseTypeId: 3,
      chargeCodeId: 12,
      amount: 80.5,
      date: "2026-10-05",
      merchant: "BP Welshpool",
      confirm: true,
    };

    it.each([
      ["unset", ""],
      ["not a number", "twenty"],
      ["zero", "0"],
      ["negative", "-3"],
      ["a number with text after it", "20x"],
    ])("refuses all three expense tools when it is %s, and makes no request", async (_label, value) => {
      vi.stubEnv("CW_MANAGE_MEMBER_ID", value);
      const cw = fakeConnectWise({ entries: [{ id: 900, member: { id: 20 } }] });
      const dir = await mkdtemp(path.join(tmpdir(), "cw-receipts-"));
      try {
        vi.stubEnv("CW_MANAGE_ATTACH_ROOT", dir);
        const file = path.join(dir, "r.pdf");
        await writeFile(file, Buffer.from("%PDF-1.4"));

        const search = await call("cw_search_expense_entries", {});
        const create = await call("cw_create_expense_entry", claim);
        const attach = await call("cw_attach_document", {
          recordType: "Expense",
          recordId: 900,
          filePath: file,
          confirm: true,
        });

        for (const result of [search, create, attach]) {
          expect(result.isError).toBe(true);
          expect(String(body(result).message)).toContain("CW_MANAGE_MEMBER_ID");
        }
        expect(cw.fetchMock).not.toHaveBeenCalled();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("names the variable and says nothing was read or changed when it is unset", async () => {
      vi.stubEnv("CW_MANAGE_MEMBER_ID", "");
      fakeConnectWise();
      const result = await call("cw_search_expense_entries", {});
      expect(String(body(result).message)).toMatch(
        /need CW_MANAGE_MEMBER_ID.*not set, so nothing was read or changed/,
      );
    });

    it("never calls /system/myAccount, which answers 404 on this ConnectWise", async () => {
      const cw = fakeConnectWise({ entries: [] });
      await call("cw_search_expense_entries", {});
      await call("cw_create_expense_entry", claim);
      expect(cw.calls.some((c) => c.path.toLowerCase() === "/system/myaccount")).toBe(false);
      expect(cw.calls.length).toBeGreaterThan(0);
    });

    it("uses the member id in the variable for the claim", async () => {
      vi.stubEnv("CW_MANAGE_MEMBER_ID", "31");
      const cw = fakeConnectWise();
      await call("cw_create_expense_entry", claim);
      expect(cw.calls.find((c) => c.method === "POST")!.body).toMatchObject({ member: { id: 31 } });
      const search = cw.calls.find((c) => c.path === "/expense/entries" && c.method === "GET")!;
      expect(search.query.get("conditions")).toContain("member/id = 31");
    });
  });

  describe("cw_create_expense_entry (D22 to D24)", () => {
    const claim = {
      expenseTypeId: 3,
      chargeCodeId: 12,
      amount: 80.5,
      date: "2026-10-05",
      merchant: "BP Welshpool",
    };

    it("requires the expense type, with no default, and takes the charge code as optional", async () => {
      const tools = (
        await mcp<{ tools: { name: string; inputSchema: { required?: string[]; properties: Record<string, Rec> } }[] }>(
          "tools/list",
          {},
        )
      ).result.tools;
      const tool = tools.find((t) => t.name === "cw_create_expense_entry")!;
      expect(tool.inputSchema.required).toEqual(
        expect.arrayContaining(["expenseTypeId", "amount", "date", "merchant"]),
      );
      expect(tool.inputSchema.required).not.toContain("chargeCodeId");
      expect(tool.inputSchema.properties.expenseTypeId).not.toHaveProperty("default");
      expect(tool.inputSchema.properties.chargeCodeId).not.toHaveProperty("default");
      // There is no member parameter: the claim is always the owner's own.
      expect(tool.inputSchema.properties).not.toHaveProperty("memberId");
    });

    it("refuses a call without the expense type, with no request", async () => {
      const cw = fakeConnectWise();
      const { expenseTypeId: _a, ...noType } = claim;
      const result = await call("cw_create_expense_entry", { ...noType, confirm: true });
      expect(result.isError).toBe(true);
      expect(cw.fetchMock).not.toHaveBeenCalled();
    });

    describe("charge-to: a charge code or a company (D22 amended)", () => {
      const { chargeCodeId: _code, ...base } = claim;
      const withCompany = { ...base, companyId: 250 };

      it("lists both as optional parameters with no default", async () => {
        const tools = (
          await mcp<{ tools: { name: string; inputSchema: { required?: string[]; properties: Record<string, Rec> } }[] }>(
            "tools/list",
            {},
          )
        ).result.tools;
        const tool = tools.find((t) => t.name === "cw_create_expense_entry")!;
        expect(tool.inputSchema.properties).toHaveProperty("chargeCodeId");
        expect(tool.inputSchema.properties).toHaveProperty("companyId");
        expect(tool.inputSchema.properties.companyId).not.toHaveProperty("default");
        expect(tool.inputSchema.required).not.toContain("chargeCodeId");
        expect(tool.inputSchema.required).not.toContain("companyId");
      });

      it("refuses a claim with neither, with no request, even when confirmed", async () => {
        const cw = fakeConnectWise();
        const result = await call("cw_create_expense_entry", { ...base, confirm: true });
        expect(result.isError).toBe(true);
        expect(String(body(result).message)).toMatch(/needs a charge-to.*exactly one of chargeCodeId and companyId/);
        expect(cw.fetchMock).not.toHaveBeenCalled();
      });

      it("refuses a claim with both, with no request", async () => {
        const cw = fakeConnectWise();
        const result = await call("cw_create_expense_entry", { ...base, chargeCodeId: 12, companyId: 250, confirm: true });
        expect(result.isError).toBe(true);
        expect(String(body(result).message)).toMatch(/not both/);
        expect(cw.fetchMock).not.toHaveBeenCalled();
      });

      it("sends the company as the entry's company reference, with no charge-to type", async () => {
        const cw = fakeConnectWise();

        const plan = await call("cw_create_expense_entry", withCompany);
        const planned = (body(plan) as { planned: Rec }).planned;
        expect(planned).toMatchObject({ company: { id: 250 } });
        expect(planned).not.toHaveProperty("chargeToType");
        expect(planned).not.toHaveProperty("chargeToId");

        const made = await call("cw_create_expense_entry", { ...withCompany, confirm: true });
        expect(made.isError).not.toBe(true);
        const post = cw.calls.find((c) => c.method === "POST")!.body as Rec;
        expect(post).toMatchObject({ member: { id: 20 }, type: { id: 3 }, amount: 80.5, company: { id: 250 } });
        expect(post).not.toHaveProperty("chargeToType");
        expect(post).not.toHaveProperty("chargeToId");
      });

      it("shows the company in the read back, and checks it", async () => {
        fakeConnectWise();
        const result = await call("cw_create_expense_entry", { ...withCompany, confirm: true });
        expect(body(result)).toMatchObject({ saved: true, verified: true, entry: { company: { id: 250 } } });
      });

      it("reports a company the fresh read does not hold", async () => {
        fakeConnectWise({ dropCompany: true });
        const result = await call("cw_create_expense_entry", { ...withCompany, confirm: true });
        expect(result.isError).toBe(true);
        expect(body(result)).toMatchObject({ verified: false, mismatches: ["company"] });
      });

      it("sends the charge code as the charge-to, and no company, when a charge code is given", async () => {
        const cw = fakeConnectWise();
        const result = await call("cw_create_expense_entry", { ...claim, confirm: true });
        const post = cw.calls.find((c) => c.method === "POST")!.body as Rec;
        expect(post).toMatchObject({ chargeToType: "ChargeCode", chargeToId: 12 });
        expect(post).not.toHaveProperty("company");
        expect(body(result)).toMatchObject({ verified: true, entry: { chargeToId: 12, company: null } });
      });

      it("takes Do Not Bill and writes the notes as merchant, then the note", async () => {
        const cw = fakeConnectWise();

        const result = await call("cw_create_expense_entry", {
          ...withCompany,
          expenseTypeId: 7,
          merchant: "Ampol",
          notes: "Petrol",
          billableOption: "DoNotBill",
          confirm: true,
        });

        expect(body(result)).toMatchObject({ saved: true, verified: true, entry: { notes: "Ampol, Petrol" } });
        expect(cw.calls.find((c) => c.method === "POST")!.body).toMatchObject({
          type: { id: 7 },
          billableOption: "DoNotBill",
          notes: "Ampol, Petrol",
        });
      });

      it("does not double the merchant when the note already names it", async () => {
        const cw = fakeConnectWise();
        await call("cw_create_expense_entry", {
          ...withCompany,
          merchant: "Ampol",
          notes: "ampol, Petrol",
          confirm: true,
        });
        expect(cw.calls.find((c) => c.method === "POST")!.body).toMatchObject({ notes: "ampol, Petrol" });
      });
    });

    it("makes no write without confirm: true, and shows the duplicate check", async () => {
      const cw = fakeConnectWise();
      const result = await call("cw_create_expense_entry", claim);
      expect(result.isError).toBe(true);
      expect(writes(cw.calls)).toEqual([]);
      expect(body(result)).toMatchObject({
        saved: false,
        planned: {
          member: { id: 20 },
          type: { id: 3 },
          chargeToType: "ChargeCode",
          chargeToId: 12,
          amount: 80.5,
          date: "2026-10-05T00:00:00Z",
          notes: "BP Welshpool",
        },
        duplicateCheck: { duplicates: [], similar: [] },
      });
    });

    it("creates the claim for the owner's own member and reads it back", async () => {
      const cw = fakeConnectWise();

      const result = await call("cw_create_expense_entry", { ...claim, notes: "Fuel for the site visit", confirm: true });

      expect(result.isError).not.toBe(true);
      expect(body(result)).toMatchObject({
        saved: true,
        verified: true,
        entry: { id: 900, amount: 80.5, memberId: 20, chargeToId: 12, notes: "BP Welshpool, Fuel for the site visit" },
      });
      const post = cw.calls.find((c) => c.method === "POST")!;
      expect(post.path).toBe("/expense/entries");
      expect(post.body).toMatchObject({ member: { id: 20 }, type: { id: 3 }, chargeToType: "ChargeCode", chargeToId: 12 });
      expect(cw.calls.at(-1)).toMatchObject({ method: "GET", path: "/expense/entries/900" });
    });

    it("runs the duplicate check before it writes", async () => {
      const cw = fakeConnectWise();
      await call("cw_create_expense_entry", { ...claim, confirm: true });
      const check = cw.calls.findIndex((c) => c.path === "/expense/entries" && c.method === "GET");
      const post = cw.calls.findIndex((c) => c.method === "POST");
      expect(check).toBeGreaterThanOrEqual(0);
      expect(check).toBeLessThan(post);
    });

    it("refuses a claim that matches date, amount and merchant, and writes nothing", async () => {
      const cw = fakeConnectWise({
        entries: [
          { id: 55, date: "2026-10-05T00:00:00Z", amount: 80.5, member: { id: 20 }, notes: "bp welshpool fuel" },
        ],
      });

      const result = await call("cw_create_expense_entry", { ...claim, confirm: true });

      expect(result.isError).toBe(true);
      expect(String(body(result).message)).toMatch(/already exists \(entry 55\)/);
      expect(writes(cw.calls)).toEqual([]);
    });

    it("matches a date stored as Perth midnight", async () => {
      // 2026-10-05 00:00 Perth is 2026-10-04T16:00:00Z.
      const cw = fakeConnectWise({
        entries: [{ id: 56, date: "2026-10-04T16:00:00Z", amount: 80.5, member: { id: 20 }, notes: "BP Welshpool" }],
      });
      const result = await call("cw_create_expense_entry", { ...claim, confirm: true });
      expect(String(body(result).message)).toMatch(/entry 56/);
      expect(writes(cw.calls)).toEqual([]);
    });

    it("shows an entry with the same date and amount but another merchant, and still allows the claim", async () => {
      const cw = fakeConnectWise({
        entries: [{ id: 57, date: "2026-10-05T00:00:00Z", amount: 80.5, member: { id: 20 }, notes: "Shell Kewdale" }],
      });

      const plan = await call("cw_create_expense_entry", claim);
      expect(body(plan)).toMatchObject({ duplicateCheck: { duplicates: [], similar: [{ id: 57 }] } });

      const made = await call("cw_create_expense_entry", { ...claim, confirm: true });
      expect(body(made)).toMatchObject({ saved: true });
      expect(cw.calls.some((c) => c.method === "POST")).toBe(true);
    });

    it("ignores another member's matching entry", async () => {
      fakeConnectWise({
        entries: [{ id: 58, date: "2026-10-05T00:00:00Z", amount: 80.5, member: { id: 99 }, notes: "BP Welshpool" }],
      });
      const result = await call("cw_create_expense_entry", { ...claim, confirm: true });
      expect(body(result)).toMatchObject({ saved: true });
    });

    it("reports a value the fresh read does not hold", async () => {
      fakeConnectWise({ alterAmount: true });
      const result = await call("cw_create_expense_entry", { ...claim, confirm: true });
      expect(result.isError).toBe(true);
      expect(body(result)).toMatchObject({ saved: true, verified: false, mismatches: ["amount"] });
    });
  });

  describe("cw_attach_document", () => {
    let root: string;
    let outside: string;
    const entry = { id: 900, date: "2026-10-05T00:00:00Z", amount: 80.5, member: { id: 20 }, notes: "BP Welshpool" };
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("receipt body\n"), Buffer.from([0, 255, 128])]);

    beforeEach(async () => {
      root = await mkdtemp(path.join(tmpdir(), "cw-receipts-"));
      outside = await mkdtemp(path.join(tmpdir(), "cw-outside-"));
      vi.stubEnv("CW_MANAGE_ATTACH_ROOT", root);
    });
    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    });

    async function receipt(name = "bp-5-oct.pdf", data: Buffer = pdf) {
      const file = path.join(root, name);
      await writeFile(file, data);
      return file;
    }

    it("refuses when no attach folder is configured, and reads nothing", async () => {
      vi.stubEnv("CW_MANAGE_ATTACH_ROOT", "");
      const file = await receipt();
      const cw = fakeConnectWise({ entries: [entry] });
      const result = await call("cw_attach_document", { recordType: "Expense", recordId: 900, filePath: file, confirm: true });
      expect(result.isError).toBe(true);
      expect(String(body(result).message)).toMatch(/CW_MANAGE_ATTACH_ROOT/);
      expect(cw.fetchMock).not.toHaveBeenCalled();
    });

    it("refuses a file outside the folder, including one reached through a link", async () => {
      const cw = fakeConnectWise({ entries: [entry] });
      const stray = path.join(outside, "stray.pdf");
      await writeFile(stray, pdf);

      const direct = await call("cw_attach_document", { recordType: "Expense", recordId: 900, filePath: stray, confirm: true });
      expect(String(body(direct).message)).toMatch(/not under the folder/);

      const link = path.join(root, "link.pdf");
      let linked = true;
      try {
        await symlink(stray, link);
      } catch {
        linked = false; // symlinks need a privilege on some Windows setups
      }
      if (linked) {
        const viaLink = await call("cw_attach_document", { recordType: "Expense", recordId: 900, filePath: link, confirm: true });
        expect(String(body(viaLink).message)).toMatch(/not under the folder/);
      }
      expect(cw.fetchMock).not.toHaveBeenCalled();
    });

    it("refuses a wrong extension, a fake PDF, an empty file and an oversize file", async () => {
      const cw = fakeConnectWise({ entries: [entry] });
      const run = async (file: string) =>
        body(await call("cw_attach_document", { recordType: "Expense", recordId: 900, filePath: file, confirm: true }));

      expect(String((await run(await receipt("notes.txt", Buffer.from("hi")))).message)).toMatch(/not an accepted receipt type/);
      expect(String((await run(await receipt("fake.pdf", Buffer.from("not a pdf")))).message)).toMatch(/is not a PDF/);
      expect(String((await run(await receipt("empty.pdf", Buffer.alloc(0)))).message)).toMatch(/empty/);
      const big = Buffer.alloc(10 * 1024 * 1024 + 1);
      big.write("%PDF-");
      expect(String((await run(await receipt("big.pdf", big))).message)).toMatch(/over the .* byte limit/);
      expect(cw.fetchMock).not.toHaveBeenCalled();
    });

    it("refuses an entry that is not the owner's own claim", async () => {
      const cw = fakeConnectWise({ entries: [{ ...entry, member: { id: 99 } }] });
      const file = await receipt();
      const result = await call("cw_attach_document", { recordType: "Expense", recordId: 900, filePath: file, confirm: true });
      expect(result.isError).toBe(true);
      expect(String(body(result).message)).toMatch(/D23/);
      expect(writes(cw.calls)).toEqual([]);
    });

    it("makes no write without confirm: true, and returns the file's name, size and SHA-256", async () => {
      const cw = fakeConnectWise({ entries: [entry] });
      const file = await receipt();

      const result = await call("cw_attach_document", { recordType: "Expense", recordId: 900, filePath: file });

      expect(result.isError).toBe(true);
      const plan = (body(result) as { planned: Rec }).planned;
      expect(plan).toMatchObject({ fileName: "bp-5-oct.pdf", fileSize: pdf.length, contentType: "application/pdf" });
      expect(String(plan.sha256)).toMatch(/^[0-9a-f]{64}$/);
      expect(writes(cw.calls)).toEqual([]);
    });

    it("uploads the file as multipart, reads the entry's documents back and leaves the file alone", async () => {
      const cw = fakeConnectWise({ entries: [entry] });
      const file = await receipt();
      const before = await readFile(file);
      const modifiedBefore = (await stat(file)).mtimeMs;

      const result = await call("cw_attach_document", { recordType: "Expense", recordId: 900, filePath: file, confirm: true });

      expect(result.isError).not.toBe(true);
      expect(body(result)).toMatchObject({
        attached: true,
        verified: true,
        document: { id: 1100, fileName: "bp-5-oct.pdf" },
      });
      const post = cw.calls.find((c) => c.method === "POST")!;
      expect(post.path).toBe("/system/documents");
      expect(post.contentType).toMatch(/^multipart\/form-data; boundary=/);
      const raw = Buffer.from(post.body as Uint8Array);
      expect(raw.includes(pdf)).toBe(true);
      expect(raw.toString("latin1")).toContain('name="recordType"\r\n\r\nExpense');
      expect(raw.toString("latin1")).toContain('filename="bp-5-oct.pdf"');

      // Never moved, renamed or changed.
      expect((await readFile(file)).equals(before)).toBe(true);
      expect((await stat(file)).mtimeMs).toBe(modifiedBefore);
    });

    it("does not attach the same file twice", async () => {
      const cw = fakeConnectWise({
        entries: [entry],
        documents: [{ id: 1, recordId: 900, fileName: "bp-5-oct.pdf", fileSize: pdf.length }],
      });
      const file = await receipt();
      const result = await call("cw_attach_document", { recordType: "Expense", recordId: 900, filePath: file, confirm: true });
      expect(body(result)).toMatchObject({ attached: false, alreadyPresent: true });
      expect(writes(cw.calls)).toEqual([]);
    });

    it("says nothing was added, and names the document, when ConnectWise answers with one already on the entry", async () => {
      // The listing has no fileSize, so the before-upload check cannot match on size and the
      // upload goes out. ConnectWise answers it with the existing document's id.
      const cw = fakeConnectWise({
        entries: [entry],
        documents: [{ id: 1, recordId: 900, title: "BP receipt", fileName: "bp-5-oct.pdf" }],
        dedupeDocuments: true,
      });
      const file = await receipt();

      const result = await call("cw_attach_document", { recordType: "Expense", recordId: 900, filePath: file, confirm: true });

      expect(result.isError).not.toBe(true);
      const out = body(result);
      expect(out).toMatchObject({
        attached: false,
        alreadyPresent: true,
        document: { id: 1, title: "BP receipt", fileName: "bp-5-oct.pdf" },
      });
      expect(String(out.message)).toMatch(/document 1, which was already on the entry/);
      expect(out).not.toHaveProperty("verified");
      expect(cw.world.documents).toHaveLength(1);
    });

    it("reports the new document, not an older one with the same name, when the upload creates one", async () => {
      // An older document of the same name but a different size is a different receipt.
      const cw = fakeConnectWise({
        entries: [entry],
        documents: [{ id: 1, recordId: 900, fileName: "bp-5-oct.pdf", fileSize: 5 }],
      });
      const file = await receipt();

      const result = await call("cw_attach_document", { recordType: "Expense", recordId: 900, filePath: file, confirm: true });

      expect(result.isError).not.toBe(true);
      expect(body(result)).toMatchObject({
        attached: true,
        verified: true,
        document: { id: 1100, fileName: "bp-5-oct.pdf", fileSize: pdf.length },
      });
      expect(cw.world.documents).toHaveLength(2);
    });

    it("only offers Expense as a record type", async () => {
      fakeConnectWise({ entries: [entry] });
      const file = await receipt();
      const result = await call("cw_attach_document", { recordType: "Ticket", recordId: 900, filePath: file, confirm: true });
      expect(result.isError).toBe(true);
    });
  });
});

describe("a stray empty directory is not a receipt", () => {
  it("is refused as a file that cannot be read", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cw-receipts-"));
    try {
      vi.stubEnv("CW_MANAGE_ATTACH_ROOT", root);
      vi.stubEnv("CW_MANAGE_MEMBER_ID", "20");
      const dir = path.join(root, "folder.pdf");
      await mkdir(dir);
      const cw = fakeConnectWise({ entries: [{ id: 900, member: { id: 20 } }] });
      const result = await call("cw_attach_document", { recordType: "Expense", recordId: 900, filePath: dir, confirm: true });
      expect(result.isError).toBe(true);
      expect(writes(cw.calls)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

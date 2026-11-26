/**
 * AUTH_MODE=entra-keys over real HTTP.
 *
 * Starts the real server. Tokens are really signed and really verified: only the
 * source of the signing keys is local instead of Entra's. Key Vault and
 * ConnectWise are faked, so each test can see which keys reached ConnectWise.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import type { JWTVerifyGetKey } from "jose";

const state = vi.hoisted(() => ({
  jwks: undefined as unknown,
  secrets: new Map<string, string>(),
  reads: [] as string[],
  vaultError: undefined as Error | undefined,
}));

vi.mock("jose", async () => {
  const actual = await vi.importActual<typeof import("jose")>("jose");
  return {
    ...actual,
    createRemoteJWKSet: () =>
      ((header, token) => (state.jwks as JWTVerifyGetKey)(header, token)) as JWTVerifyGetKey,
  };
});

vi.mock("@azure/identity", () => ({ ManagedIdentityCredential: class {} }));

vi.mock("@azure/keyvault-secrets", () => ({
  SecretClient: class {
    async getSecret(name: string) {
      state.reads.push(name);
      if (state.vaultError) throw state.vaultError;
      const value = state.secrets.get(name);
      if (value === undefined) {
        throw Object.assign(new Error("not found"), { statusCode: 404, code: "SecretNotFound" });
      }
      return { value };
    }
  },
}));

import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";

const TENANT = "0000aaaa-0000-0000-0000-000000000001";
const CLIENT = "0000bbbb-0000-0000-0000-000000000002";
const WITH_KEYS = "aaaaaaaa-1111-1111-1111-111111111111";
const SECOND = "bbbbbbbb-2222-2222-2222-222222222222";
const NO_KEYS = "cccccccc-3333-3333-3333-333333333333";
const VAULT_DOWN = "dddddddd-4444-4444-4444-444444444444";
const STATIC_TOKEN = "static-token-that-must-not-work";
const SECRET_VALUES = ["first-public", "first-private", "second-public", "second-private"];

const ENV = {
  MCP_TRANSPORT: "http",
  MCP_HTTP_HOST: "127.0.0.1",
  MCP_OAUTH_ENABLED: "true",
  AUTH_MODE: "entra-keys",
  MCP_SERVER_URL: "https://cw-mcp.example.test",
  AZURE_TENANT_ID: TENANT,
  AZURE_CLIENT_ID: CLIENT,
  AZURE_AUDIENCE: `api://${CLIENT}`,
  MCP_BEARER_TOKEN: STATIC_TOKEN,
  KEY_VAULT_URI: "https://kv-test.vault.azure.net/",
  AZURE_CLIENT_ID_MI: "0000cccc-0000-0000-0000-000000000003",
  CW_MANAGE_URL: "https://cw.example.test/",
  CW_MANAGE_COMPANY_ID: "examplecompany",
  CW_MANAGE_CLIENT_ID: "shared-client-id",
  // Present to prove they are never used in this mode.
  CW_MANAGE_PUBLIC_KEY: "env-public",
  CW_MANAGE_PRIVATE_KEY: "env-private",
};

let port = 0;
let signingKey: CryptoKey;
const logged: string[] = [];
const cwCalls: Array<{ url: string; headers: Record<string, string> }> = [];

interface TokenOptions {
  oid?: string;
  upn?: string;
  roles?: string[];
  audience?: string;
  tenant?: string;
  expiresIn?: number;
}

async function token(options: TokenOptions = {}): Promise<string> {
  const tenant = options.tenant ?? TENANT;
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    tid: tenant,
    oid: options.oid ?? WITH_KEYS,
    preferred_username: options.upn ?? "first@example.test",
    roles: options.roles ?? ["CWM.Access"],
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(`https://login.microsoftonline.com/${tenant}/v2.0`)
    .setAudience(options.audience ?? `api://${CLIENT}`)
    .setIssuedAt(now - 600)
    .setExpirationTime(now + (options.expiresIn ?? 600))
    .sign(signingKey);
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A request to the server under test. Uses node:http, because fetch is faked for ConnectWise. */
function send(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function rpc(
  bearer: string | undefined,
  method: string,
  params: Record<string, unknown> = {},
  extra: Record<string, string> = {},
): Promise<Reply> {
  return send(
    "POST",
    "/mcp",
    {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...extra,
    },
    JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  );
}

const callTool = (bearer: string, name = "cw_test_connection", args = {}, extra = {}) =>
  rpc(bearer, "tools/call", { name, arguments: args }, extra);

const toolResult = (reply: Reply) =>
  JSON.parse(reply.body).result as { isError?: boolean; content: Array<{ text: string }> };

function decodedAuth(headers: Record<string, string>): string {
  return Buffer.from(headers.Authorization!.replace(/^Basic /, ""), "base64").toString("utf8");
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "RS256" };
  state.jwks = createLocalJWKSet({ keys: [jwk] });

  state.secrets.set(`cw-${WITH_KEYS}-public`, "first-public");
  state.secrets.set(`cw-${WITH_KEYS}-private`, "first-private");
  state.secrets.set(`cw-${SECOND}-public`, "second-public");
  state.secrets.set(`cw-${SECOND}-private`, "second-private");

  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      cwCalls.push({ url: String(url), headers: init.headers });
      return new Response(JSON.stringify({ version: "test" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );

  port = await new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const found = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(found));
    });
  });
  for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
  vi.stubEnv("MCP_HTTP_PORT", String(port));

  await import("../index.js");
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await send("GET", "/health");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("server did not start");
}, 60_000);

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  cwCalls.length = 0;
  state.reads.length = 0;
  state.vaultError = undefined;
  logged.length = 0;
});

describe("entra-keys: health and discovery", () => {
  it("reports the mode and that OAuth is on", async () => {
    const reply = await send("GET", "/health");

    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toMatchObject({ authMode: "entra-keys", oauthEnabled: true });
  });

  it("names the public server URL in both discovery documents", async () => {
    const resource = JSON.parse(
      (await send("GET", "/.well-known/oauth-protected-resource")).body,
    );
    const server = JSON.parse(
      (await send("GET", "/.well-known/oauth-authorization-server")).body,
    );

    expect(resource.resource).toBe("https://cw-mcp.example.test/mcp");
    expect(server.issuer).toBe("https://cw-mcp.example.test");
  });
});

describe("entra-keys: refused before any key is read", () => {
  const refused = async (reply: Reply, status: number) => {
    expect(reply.status).toBe(status);
    expect(state.reads).toEqual([]);
    expect(cwCalls).toEqual([]);
  };

  it("answers 401 with the protected-resource document when there is no token", async () => {
    const reply = await rpc(undefined, "tools/list");

    await refused(reply, 401);
    expect(reply.headers["www-authenticate"]).toBe(
      'Bearer resource_metadata="https://cw-mcp.example.test/.well-known/oauth-protected-resource"',
    );
  });

  it("refuses the static bearer token although MCP_BEARER_TOKEN is set", async () => {
    const reply = await callTool(STATIC_TOKEN);

    await refused(reply, 401);
    expect(logged.join("\n")).not.toContain("cli-user");
  });

  it("answers 403 to a token with no CWM.Access role", async () => {
    await refused(await callTool(await token({ roles: [] })), 403);
    await refused(await callTool(await token({ roles: ["Other.Role"] })), 403);
  });

  it("answers 401 to a token for another audience", async () => {
    const reply = await callTool(await token({ audience: "api://some-other-app" }));

    await refused(reply, 401);
    expect(reply.headers["www-authenticate"]).toContain('error="invalid_token"');
  });

  it("answers 401 to a token from another tenant", async () => {
    await refused(
      await callTool(await token({ tenant: "ffffffff-0000-0000-0000-000000000009" })),
      401,
    );
  });

  it("answers 401 to an expired token", async () => {
    await refused(await callTool(await token({ expiresIn: -60 })), 401);
  });
});

describe("entra-keys: a person with keys", () => {
  it("calls ConnectWise with that person's own keys and the shared values", async () => {
    const reply = await callTool(await token());

    expect(reply.status).toBe(200);
    expect(toolResult(reply).isError).toBeFalsy();
    expect(cwCalls.length).toBeGreaterThan(0);
    for (const call of cwCalls) {
      expect(call.url.startsWith("https://cw.example.test/v4_6_release/apis/3.0/")).toBe(true);
      expect(decodedAuth(call.headers)).toBe("examplecompany+first-public:first-private");
      expect(call.headers.clientId).toBe("shared-client-id");
    }
  });

  it("gives a second person their own keys", async () => {
    await callTool(await token({ oid: SECOND, upn: "second@example.test" }));

    expect(cwCalls.length).toBeGreaterThan(0);
    for (const call of cwCalls) {
      expect(decodedAuth(call.headers)).toBe("examplecompany+second-public:second-private");
    }
  });

  it("ignores gateway credential headers sent by the caller", async () => {
    await callTool(await token(), "cw_test_connection", {}, {
      "X-CW-Company-Id": "attacker",
      "X-CW-Public-Key": "attacker",
      "X-CW-Private-Key": "attacker",
      "X-CW-Client-Id": "attacker",
      "X-CW-Url": "https://attacker.example.test",
    });

    expect(cwCalls.length).toBeGreaterThan(0);
    for (const call of cwCalls) {
      expect(call.url.startsWith("https://cw.example.test/")).toBe(true);
      expect(decodedAuth(call.headers)).toBe("examplecompany+first-public:first-private");
    }
  });

  it("audits the UPN and logs no secret value or token", async () => {
    const bearer = await token();
    await callTool(bearer);

    const all = logged.join("\n");
    expect(all).toMatch(/\[audit\] first@example\.test \| .+ \| POST \/mcp/);
    for (const value of [...SECRET_VALUES, bearer, STATIC_TOKEN]) {
      expect(all).not.toContain(value);
    }
  });
});

describe("entra-keys: a person with no keys", () => {
  const person = () => token({ oid: NO_KEYS, upn: "nokeys@example.test" });
  const message =
    "No ConnectWise API keys are on file for nokeys@example.test. Ask Stephan to add your key pair to the hosted ConnectWise MCP.";

  it.each([
    ["cw_test_connection", {}],
    ["cw_search_tickets", {}],
    ["cw_add_ticket_note", { ticketId: 1, text: "note", internalAnalysisFlag: true }],
    ["cw_no_such_tool", {}],
  ])("answers %s with the refusal as a tool error and calls nothing", async (name, args) => {
    const reply = await callTool(await person(), name, args);

    expect(reply.status).toBe(200);
    expect(toolResult(reply)).toEqual({
      content: [{ type: "text", text: message }],
      isError: true,
    });
    expect(cwCalls).toEqual([]);
    expect(logged.join("\n")).not.toContain("env-private");
  });

  it("still lets the client connect and list the same tools", async () => {
    const mine = JSON.parse((await rpc(await token(), "tools/list")).body).result.tools;
    const theirs = JSON.parse((await rpc(await person(), "tools/list")).body).result.tools;

    expect(theirs.length).toBeGreaterThan(50);
    expect(theirs.map((t: { name: string }) => t.name)).toEqual(
      mine.map((t: { name: string }) => t.name),
    );
    expect(cwCalls).toEqual([]);
  });

  it("logs the miss with the object id and UPN", async () => {
    await callTool(await person());

    expect(logged).toContain(
      JSON.stringify({
        event: "key_lookup",
        oid: NO_KEYS,
        upn: "nokeys@example.test",
        result: "miss",
      }),
    );
  });
});

describe("entra-keys: the vault cannot be read", () => {
  it("says so with a reference, not that there are no keys, and calls nothing", async () => {
    state.vaultError = Object.assign(new Error("tenant detail"), {
      name: "RestError",
      statusCode: 503,
      code: "ServiceUnavailable",
    });

    const reply = await callTool(await token({ oid: VAULT_DOWN, upn: "down@example.test" }));

    const result = toolResult(reply);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/could not read its key store.+reference [0-9a-f-]{36}/);
    expect(result.content[0]!.text).not.toContain("No ConnectWise API keys");
    expect(result.content[0]!.text).not.toContain("tenant detail");
    expect(cwCalls).toEqual([]);
  });
});

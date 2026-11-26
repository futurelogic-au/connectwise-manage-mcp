/**
 * Tests for the per-person key store used by AUTH_MODE=entra-keys.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vault = vi.hoisted(() => ({
  getSecret: vi.fn(),
  credentialOptions: [] as unknown[],
  vaultUris: [] as string[],
}));

vi.mock("@azure/identity", () => ({
  ManagedIdentityCredential: class {
    constructor(options: unknown) {
      vault.credentialOptions.push(options);
    }
  },
}));

vi.mock("@azure/keyvault-secrets", () => ({
  SecretClient: class {
    constructor(uri: string) {
      vault.vaultUris.push(uri);
    }
    getSecret(name: string) {
      return vault.getSecret(name);
    }
  },
}));

import {
  createKeyStore,
  createKeyVaultReader,
  KeyStoreError,
  KEY_CACHE_HIT_MS,
  KEY_CACHE_MISS_MS,
  type SecretReader,
} from "../auth/key-store.js";

const OID = "11111111-2222-3333-4444-555555555555";
const UPN = "person@example.com";
const PUBLIC = "PUBLIC-VALUE-do-not-log";
const PRIVATE = "PRIVATE-VALUE-do-not-log";
const MEMBER = "147";

function pair(oid = OID): Record<string, string> {
  return { [`cw-${oid}-public`]: PUBLIC, [`cw-${oid}-private`]: PRIVATE };
}

function fakeReader(secrets: Record<string, string>) {
  const read = vi.fn(async (name: string) => secrets[name] ?? null);
  return { read } satisfies SecretReader;
}

let logged: string[] = [];

beforeEach(() => {
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("key store lookup", () => {
  it("returns the pair on file and reads the three names for that object id", async () => {
    const reader = fakeReader(pair());
    const keys = await createKeyStore(reader).resolve(OID, UPN);

    expect(keys).toEqual({ publicKey: PUBLIC, privateKey: PRIVATE });
    expect(reader.read.mock.calls.map(([name]) => name).sort()).toEqual([
      `cw-${OID}-member-id`,
      `cw-${OID}-private`,
      `cw-${OID}-public`,
    ]);
  });

  it("lower-cases the object id before naming a secret", async () => {
    const oid = "ABCDEF01-2222-3333-4444-555555555555";
    const reader = fakeReader(pair(oid.toLowerCase()));

    expect(await createKeyStore(reader).resolve(oid, UPN)).not.toBeNull();
  });

  it.each([
    ["no secrets at all", {}],
    ["only a public key", { [`cw-${OID}-public`]: PUBLIC }],
    ["only a private key", { [`cw-${OID}-private`]: PRIVATE }],
    ["a blank private key", { [`cw-${OID}-public`]: PUBLIC, [`cw-${OID}-private`]: "  " }],
    ["only a member id", { [`cw-${OID}-member-id`]: MEMBER }],
  ])("is a miss with %s", async (_label, secrets) => {
    const reader = fakeReader(secrets as Record<string, string>);

    expect(await createKeyStore(reader).resolve(OID, UPN)).toBeNull();
  });

  it.each(["static", "", "not-a-guid", `${OID}-public`, "../other"])(
    "is a miss for %j, which is not an object id, with no vault read",
    async (oid) => {
      const reader = fakeReader(pair());

      expect(await createKeyStore(reader).resolve(oid, UPN)).toBeNull();
      expect(reader.read).not.toHaveBeenCalled();
    },
  );
});

describe("key store member id", () => {
  it("returns the member id when the secret is present", async () => {
    const reader = fakeReader({ ...pair(), [`cw-${OID}-member-id`]: ` ${MEMBER}\n` });

    expect(await createKeyStore(reader).resolve(OID, UPN)).toEqual({
      publicKey: PUBLIC,
      privateKey: PRIVATE,
      memberId: 147,
    });
  });

  it("returns the pair with no member id when the secret is absent", async () => {
    const keys = await createKeyStore(fakeReader(pair())).resolve(OID, UPN);

    expect(keys).toEqual({ publicKey: PUBLIC, privateKey: PRIVATE });
    expect(keys).not.toHaveProperty("memberId");
  });

  it.each(["abc", "0", "-4", "14.7", "147abc", "   "])(
    "leaves the member id out when the secret holds %j, and does not log the value",
    async (value) => {
      const reader = fakeReader({ ...pair(), [`cw-${OID}-member-id`]: value });

      const keys = await createKeyStore(reader).resolve(OID, UPN);

      expect(keys).toEqual({ publicKey: PUBLIC, privateKey: PRIVATE });
      expect(logged).toContain(JSON.stringify({ event: "member_id_invalid", oid: OID }));
    },
  );
});

describe("key store cache", () => {
  it("reuses a hit for 15 minutes, then reads the vault again", async () => {
    expect(KEY_CACHE_HIT_MS).toBe(15 * 60 * 1000);
    let clock = 1_000_000;
    const reader = fakeReader(pair());
    const store = createKeyStore(reader, () => clock);

    await store.resolve(OID, UPN);
    clock += KEY_CACHE_HIT_MS - 1;
    await store.resolve(OID, UPN);
    expect(reader.read).toHaveBeenCalledTimes(3);

    clock += 1;
    await store.resolve(OID, UPN);
    expect(reader.read).toHaveBeenCalledTimes(6);
  });

  it("remembers a miss for 1 minute, then finds keys that have been added", async () => {
    expect(KEY_CACHE_MISS_MS).toBe(60 * 1000);
    let clock = 1_000_000;
    const secrets: Record<string, string> = {};
    const reader = fakeReader(secrets);
    const store = createKeyStore(reader, () => clock);

    expect(await store.resolve(OID, UPN)).toBeNull();
    Object.assign(secrets, pair());
    clock += KEY_CACHE_MISS_MS - 1;
    expect(await store.resolve(OID, UPN)).toBeNull();
    expect(reader.read).toHaveBeenCalledTimes(3);

    clock += 1;
    expect(await store.resolve(OID, UPN)).toEqual({ publicKey: PUBLIC, privateKey: PRIVATE });
  });

  it("drops a revoked pair once the hit has expired", async () => {
    let clock = 1_000_000;
    const secrets = pair();
    const store = createKeyStore(fakeReader(secrets), () => clock);

    await store.resolve(OID, UPN);
    delete secrets[`cw-${OID}-private`];
    clock += KEY_CACHE_HIT_MS;

    expect(await store.resolve(OID, UPN)).toBeNull();
  });

  it("keeps each person's keys apart", async () => {
    const other = "99999999-2222-3333-4444-555555555555";
    const reader = fakeReader({
      ...pair(),
      [`cw-${other}-public`]: "other-public",
      [`cw-${other}-private`]: "other-private",
    });
    const store = createKeyStore(reader);

    expect((await store.resolve(OID, UPN))?.publicKey).toBe(PUBLIC);
    expect((await store.resolve(other, "other@example.com"))?.publicKey).toBe("other-public");
    expect((await store.resolve(OID, UPN))?.publicKey).toBe(PUBLIC);
  });

  it("shares one vault read between requests that arrive together", async () => {
    const reader = fakeReader(pair());
    const store = createKeyStore(reader);

    await Promise.all([store.resolve(OID, UPN), store.resolve(OID, UPN), store.resolve(OID, UPN)]);

    expect(reader.read).toHaveBeenCalledTimes(3);
  });
});

describe("key store failure", () => {
  const failure = () =>
    Object.assign(new Error(`upstream detail ${PRIVATE}`), {
      name: "RestError",
      statusCode: 403,
      code: "Forbidden",
    });

  it("throws KeyStoreError with a reference, and does not call it a miss", async () => {
    const reader = { read: vi.fn().mockRejectedValue(failure()) };

    const error = await createKeyStore(reader)
      .resolve(OID, UPN)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KeyStoreError);
    expect((error as KeyStoreError).message).not.toContain(PRIVATE);
    const line = logged.find((l) => l.includes("key_store_error"))!;
    expect(JSON.parse(line)).toEqual({
      event: "key_store_error",
      oid: OID,
      upn: UPN,
      error: "RestError",
      status: 403,
      code: "Forbidden",
      reference: (error as KeyStoreError).reference,
    });
    expect(logged.join("\n")).not.toContain(PRIVATE);
  });

  it("does not cache a failure", async () => {
    const secrets = pair();
    const reader = fakeReader(secrets);
    reader.read.mockRejectedValueOnce(failure());
    const store = createKeyStore(reader);

    await expect(store.resolve(OID, UPN)).rejects.toBeInstanceOf(KeyStoreError);
    expect(await store.resolve(OID, UPN)).toEqual({ publicKey: PUBLIC, privateKey: PRIVATE });
  });

  it("fails when only the member id read fails", async () => {
    const secrets = pair();
    const reader = {
      read: vi.fn(async (name: string) => {
        if (name.endsWith("-member-id")) throw failure();
        return secrets[name] ?? null;
      }),
    };

    await expect(createKeyStore(reader).resolve(OID, UPN)).rejects.toBeInstanceOf(KeyStoreError);
  });
});

describe("key store logging", () => {
  it("logs the object id, UPN and hit or miss, and never a value", async () => {
    const store = createKeyStore(fakeReader({ ...pair(), [`cw-${OID}-member-id`]: "98765" }));
    const nobody = "00000000-0000-0000-0000-000000000000";

    await store.resolve(OID, UPN);
    await store.resolve(OID, UPN);
    await store.resolve(nobody, "nobody@example.com");

    expect(logged.map((l) => JSON.parse(l))).toEqual([
      { event: "key_lookup", oid: OID, upn: UPN, result: "hit" },
      { event: "key_lookup", oid: OID, upn: UPN, result: "hit" },
      { event: "key_lookup", oid: nobody, upn: "nobody@example.com", result: "miss" },
    ]);
    const all = logged.join("\n");
    expect(all).not.toContain(PUBLIC);
    expect(all).not.toContain(PRIVATE);
    expect(all).not.toContain("98765");
  });
});

describe("Key Vault reader", () => {
  beforeEach(() => {
    vault.getSecret.mockReset();
    vault.credentialOptions.length = 0;
    vault.vaultUris.length = 0;
  });

  const reader = () => createKeyVaultReader("https://kv.example.vault.azure.net/", "mi-client-id");

  const restError = (statusCode: number, code: string, inner?: string) =>
    Object.assign(new Error(code), {
      statusCode,
      code,
      details: { error: { code, ...(inner ? { innerError: { code: inner } } : {}) } },
    });

  it("signs in as the named managed identity against the named vault", async () => {
    await reader();

    expect(vault.credentialOptions).toEqual([{ clientId: "mi-client-id" }]);
    expect(vault.vaultUris).toEqual(["https://kv.example.vault.azure.net/"]);
  });

  it("returns the secret value", async () => {
    vault.getSecret.mockResolvedValue({ value: PUBLIC });

    expect(await (await reader()).read("a-name")).toBe(PUBLIC);
    expect(vault.getSecret).toHaveBeenCalledWith("a-name");
  });

  it("reads an absent secret as null", async () => {
    vault.getSecret.mockRejectedValue(restError(404, "SecretNotFound"));

    expect(await (await reader()).read("a-name")).toBeNull();
  });

  it("reads a disabled secret as null", async () => {
    vault.getSecret.mockRejectedValue(restError(403, "Forbidden", "SecretDisabled"));

    expect(await (await reader()).read("a-name")).toBeNull();
  });

  it.each([
    ["a denied identity", restError(403, "Forbidden", "ForbiddenByRbac")],
    ["a 404 that is not about the secret", restError(404, "VaultNotFound")],
    ["a throttled read", restError(429, "Throttled")],
    ["a network failure", new Error("ECONNRESET")],
  ])("throws on %s", async (_label, error) => {
    vault.getSecret.mockRejectedValue(error);

    await expect((await reader()).read("a-name")).rejects.toBe(error);
  });
});

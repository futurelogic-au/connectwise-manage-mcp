/**
 * Per-person ConnectWise API keys from Azure Key Vault (AUTH_MODE=entra-keys).
 *
 * Each person's key pair is held as two secrets named by their Entra object id:
 * `cw-<oid>-public` and `cw-<oid>-private`. An optional third, `cw-<oid>-member-id`,
 * holds that person's ConnectWise member id. The app reads them at run time
 * through its user-assigned managed identity.
 *
 * No secret value is ever logged, put in an error or returned to a caller. A
 * log line holds the object id, the UPN and the outcome, and on a failure the
 * HTTP status, the error code and a reference id.
 *
 * The Azure SDK is imported only when a vault reader is built, so stdio,
 * gateway, env and Workers use never load it.
 */

import { newErrorReference } from "../safe-error.js";

/** How long a found key pair is reused before the vault is read again. */
export const KEY_CACHE_HIT_MS = 15 * 60 * 1000;
/** How long "no keys on file" is remembered, so a newly added person waits little. */
export const KEY_CACHE_MISS_MS = 60 * 1000;

/** What the vault holds for one person. */
export interface CwPersonKeys {
  publicKey: string;
  privateKey: string;
  /** From the optional member id secret. Absent when there is none, or it is not a whole number. */
  memberId?: number;
}

export interface SecretReader {
  /**
   * The value of one secret, or null when there is no usable secret of that
   * name (absent or disabled). Throws on every other failure.
   */
  read(name: string): Promise<string | null>;
}

export interface KeyStore {
  /**
   * The keys on file for a person, or null when there is no complete key pair.
   * Throws KeyStoreError when the vault cannot be read: that is never reported
   * as "no keys" and is never cached.
   */
  resolve(oid: string, upn: string): Promise<CwPersonKeys | null>;
}

/** The vault could not be read. Carries a reference id that matches the log line. */
export class KeyStoreError extends Error {
  constructor(public readonly reference: string) {
    super(`The key store could not be read (reference ${reference})`);
    this.name = "KeyStoreError";
  }
}

/** An Entra object id. Anything else never becomes part of a secret name. */
const OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface CacheEntry {
  keys: CwPersonKeys | null;
  expiresAt: number;
}

export function createKeyStore(reader: SecretReader, now: () => number = Date.now): KeyStore {
  const cache = new Map<string, CacheEntry>();
  /** Reads in progress, so requests that arrive together share one vault read. */
  const pending = new Map<string, Promise<CwPersonKeys | null>>();

  /** The member id as a whole number above zero, or undefined. The value is never logged. */
  function toMemberId(oid: string, value: string | null): number | undefined {
    if (value === null) return undefined;
    const trimmed = value.trim();
    if (/^[1-9]\d{0,9}$/.test(trimmed)) return Number(trimmed);
    console.error(JSON.stringify({ event: "member_id_invalid", oid }));
    return undefined;
  }

  async function readPerson(oid: string): Promise<CwPersonKeys | null> {
    const [publicKey, privateKey, memberIdValue] = await Promise.all([
      reader.read(`cw-${oid}-public`),
      reader.read(`cw-${oid}-private`),
      reader.read(`cw-${oid}-member-id`),
    ]);
    let keys: CwPersonKeys | null = null;
    // Half a pair is no pair. A blank value is no value.
    if (publicKey?.trim() && privateKey?.trim()) {
      keys = { publicKey: publicKey.trim(), privateKey: privateKey.trim() };
      const memberId = toMemberId(oid, memberIdValue);
      if (memberId !== undefined) keys.memberId = memberId;
    }
    cache.set(oid, {
      keys,
      expiresAt: now() + (keys ? KEY_CACHE_HIT_MS : KEY_CACHE_MISS_MS),
    });
    return keys;
  }

  function log(oid: string, upn: string, result: "hit" | "miss"): void {
    console.error(JSON.stringify({ event: "key_lookup", oid, upn, result }));
  }

  return {
    async resolve(rawOid, upn) {
      const oid = rawOid.toLowerCase();
      if (!OBJECT_ID.test(oid)) {
        log(oid.slice(0, 64), upn, "miss");
        return null;
      }

      const cached = cache.get(oid);
      if (cached && now() < cached.expiresAt) {
        log(oid, upn, cached.keys ? "hit" : "miss");
        return cached.keys;
      }

      let read = pending.get(oid);
      if (!read) {
        read = readPerson(oid).finally(() => pending.delete(oid));
        pending.set(oid, read);
      }

      try {
        const keys = await read;
        log(oid, upn, keys ? "hit" : "miss");
        return keys;
      } catch (err) {
        const reference = newErrorReference();
        // Name, status and code only. An SDK message can carry tenant detail.
        const detail = err as { name?: unknown; statusCode?: unknown; code?: unknown };
        console.error(
          JSON.stringify({
            event: "key_store_error",
            oid,
            upn,
            error: typeof detail?.name === "string" ? detail.name : "unknown",
            status: typeof detail?.statusCode === "number" ? detail.statusCode : undefined,
            code: typeof detail?.code === "string" ? detail.code : undefined,
            reference,
          }),
        );
        throw new KeyStoreError(reference);
      }
    },
  };
}

/** True for the two Key Vault answers that mean "there is no usable secret". */
function isNoSecret(err: unknown): boolean {
  const e = err as {
    statusCode?: number;
    code?: string;
    details?: { error?: { innerError?: { code?: string } } };
  };
  if (e?.statusCode === 404 && e.code === "SecretNotFound") return true;
  // A disabled secret is a revoked one.
  return e?.statusCode === 403 && e.details?.error?.innerError?.code === "SecretDisabled";
}

/** A reader over one vault, signed in as a user-assigned managed identity. */
export async function createKeyVaultReader(
  vaultUri: string,
  managedIdentityClientId: string,
): Promise<SecretReader> {
  const { ManagedIdentityCredential } = await import("@azure/identity");
  const { SecretClient } = await import("@azure/keyvault-secrets");
  const client = new SecretClient(
    vaultUri,
    new ManagedIdentityCredential({ clientId: managedIdentityClientId }),
  );
  return {
    async read(name) {
      try {
        const secret = await client.getSecret(name);
        return secret.value ?? null;
      } catch (err) {
        if (isNoSecret(err)) return null;
        throw err;
      }
    },
  };
}

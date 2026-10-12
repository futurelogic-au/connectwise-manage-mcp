/**
 * The origins a caller-supplied ConnectWise URL may name.
 *
 * url-guard.ts proves that a gateway URL is well formed and resolves only to
 * public addresses. That still lets a caller point the server, and the
 * ConnectWise credentials it sends, at any public host. This list closes that:
 * the origin must be one an administrator has approved.
 *
 * An origin is scheme, host and port together, so the list also settles the
 * port. A URL on a port other than 443 passes only when that exact origin,
 * port included, is listed.
 *
 * This module has no imports, so url-guard.ts can use it without a cycle.
 */

/** ConnectWise's own cloud API hosts. Always allowed. */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  "https://api-na.myconnectwise.net",
  "https://api-eu.myconnectwise.net",
  "https://api-au.myconnectwise.net",
];

/**
 * Name of the environment variable that adds origins to the list: comma
 * separated, for example "https://cw.example.com,https://cw.example.com:8443".
 * Set by the operator, never by a caller.
 */
export const ALLOWED_ORIGINS_ENV = "CW_MANAGE_ALLOWED_ORIGINS";

type Env = Record<string, string | undefined>;

function currentEnv(): Env {
  return typeof process !== "undefined" && process.env ? process.env : {};
}

/**
 * Reduce one configured entry to its origin, or null when it cannot be one.
 * An entry must be a bare https origin. Anything else is dropped, never
 * loosened: there is no wildcard, and an entry with a path, credentials,
 * query or fragment is not an origin.
 */
function toOrigin(entry: string): string | null {
  let url: URL;
  try {
    url = new URL(entry.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  // "*" parses as a literal host character. It would match nothing, but an
  // entry that reads like a wildcard must not sit in the list looking valid.
  if (url.hostname.includes("*")) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return url.origin;
}

/**
 * The full set of allowed origins: the defaults plus the operator's entries.
 * Read on every call so a changed environment is picked up.
 */
export function allowedOrigins(env: Env = currentEnv()): Set<string> {
  const origins = new Set(DEFAULT_ALLOWED_ORIGINS);
  for (const entry of (env[ALLOWED_ORIGINS_ENV] ?? "").split(",")) {
    if (!entry.trim()) continue;
    const origin = toOrigin(entry);
    if (origin) origins.add(origin);
  }
  return origins;
}

/** True when the URL's origin, port included, is on the allowlist. */
export function isAllowedOrigin(url: URL, env: Env = currentEnv()): boolean {
  return allowedOrigins(env).has(url.origin);
}

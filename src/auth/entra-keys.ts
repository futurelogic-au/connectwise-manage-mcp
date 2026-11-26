/**
 * Settings and caller messages for AUTH_MODE=entra-keys: the hosted mode in
 * which the caller signs in with Entra ID and every ConnectWise call uses that
 * person's own API keys.
 */

export const ENTRA_KEYS_MODE = "entra-keys";

export interface EntraKeysSettings {
  keyVaultUri: string;
  managedIdentityClientId: string;
  /** The ConnectWise values every person shares. */
  baseUrl: string;
  companyId: string;
  clientId: string;
}

/**
 * Read the settings for entra-keys mode, or throw so the server does not start.
 * Valid only over HTTP with MCP_OAUTH_ENABLED=true: without a validated token
 * there is no object id to choose keys by.
 */
export function readEntraKeysSettings(
  env: Record<string, string | undefined>,
): EntraKeysSettings {
  if ((env.MCP_TRANSPORT || "stdio") !== "http") {
    throw new Error("AUTH_MODE=entra-keys needs MCP_TRANSPORT=http. The server was not started.");
  }
  if (env.MCP_OAUTH_ENABLED !== "true") {
    throw new Error(
      "AUTH_MODE=entra-keys needs MCP_OAUTH_ENABLED=true. The server was not started.",
    );
  }

  // No default for the ConnectWise URL: a person's keys must not go to a host nobody named.
  const required = [
    "KEY_VAULT_URI",
    "AZURE_CLIENT_ID_MI",
    "CW_MANAGE_URL",
    "CW_MANAGE_COMPANY_ID",
    "CW_MANAGE_CLIENT_ID",
  ] as const;
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `AUTH_MODE=entra-keys needs ${missing.join(", ")}. The server was not started.`,
    );
  }

  const value = (name: (typeof required)[number]) => env[name]!.trim();
  for (const name of ["KEY_VAULT_URI", "CW_MANAGE_URL"] as const) {
    if (!/^https:\/\//i.test(value(name))) {
      throw new Error(`${name} must be an https URL. The server was not started.`);
    }
  }

  return {
    keyVaultUri: value("KEY_VAULT_URI"),
    managedIdentityClientId: value("AZURE_CLIENT_ID_MI"),
    baseUrl: value("CW_MANAGE_URL").replace(/\/+$/, ""),
    companyId: value("CW_MANAGE_COMPANY_ID"),
    clientId: value("CW_MANAGE_CLIENT_ID"),
  };
}

/** What a signed-in person with no keys on file is told. */
export function noKeysMessage(upn: string): string {
  return `No ConnectWise API keys are on file for ${upn}. Ask Stephan to add your key pair to the hosted ConnectWise MCP.`;
}

/** What a caller is told when the vault cannot be read. */
export function keyStoreFailureMessage(reference: string): string {
  return `The hosted ConnectWise MCP could not read its key store, so no ConnectWise request was made. Try again in a few minutes (reference ${reference}).`;
}

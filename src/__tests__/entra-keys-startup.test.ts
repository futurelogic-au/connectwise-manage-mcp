/**
 * AUTH_MODE=entra-keys refuses to start unless it is fully set up.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { readEntraKeysSettings } from "../auth/entra-keys.js";

const GOOD: Record<string, string> = {
  MCP_TRANSPORT: "http",
  MCP_OAUTH_ENABLED: "true",
  KEY_VAULT_URI: "https://kv-test.vault.azure.net/",
  AZURE_CLIENT_ID_MI: "mi-client-id",
  CW_MANAGE_URL: "https://cw.example.test/",
  CW_MANAGE_COMPANY_ID: "examplecompany",
  CW_MANAGE_CLIENT_ID: "shared-client-id",
};

describe("readEntraKeysSettings", () => {
  it("returns the settings, with no trailing slash on the ConnectWise URL", () => {
    expect(readEntraKeysSettings(GOOD)).toEqual({
      keyVaultUri: "https://kv-test.vault.azure.net/",
      managedIdentityClientId: "mi-client-id",
      baseUrl: "https://cw.example.test",
      companyId: "examplecompany",
      clientId: "shared-client-id",
    });
  });

  it.each([undefined, "", "false", "TRUE", "1"])(
    "refuses when MCP_OAUTH_ENABLED is %j",
    (value) => {
      expect(() => readEntraKeysSettings({ ...GOOD, MCP_OAUTH_ENABLED: value })).toThrow(
        /needs MCP_OAUTH_ENABLED=true/,
      );
    },
  );

  it.each([undefined, "stdio"])("refuses when MCP_TRANSPORT is %j", (value) => {
    expect(() => readEntraKeysSettings({ ...GOOD, MCP_TRANSPORT: value })).toThrow(
      /needs MCP_TRANSPORT=http/,
    );
  });

  it.each([
    "KEY_VAULT_URI",
    "AZURE_CLIENT_ID_MI",
    "CW_MANAGE_URL",
    "CW_MANAGE_COMPANY_ID",
    "CW_MANAGE_CLIENT_ID",
  ])("refuses when %s is missing or blank", (name) => {
    expect(() => readEntraKeysSettings({ ...GOOD, [name]: undefined })).toThrow(name);
    expect(() => readEntraKeysSettings({ ...GOOD, [name]: "  " })).toThrow(name);
  });

  it.each(["KEY_VAULT_URI", "CW_MANAGE_URL"])("refuses a %s that is not https", (name) => {
    expect(() => readEntraKeysSettings({ ...GOOD, [name]: "http://example.test" })).toThrow(
      /must be an https URL/,
    );
  });
});

describe("starting the server in entra-keys mode without OAuth", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it.each([
    ["over HTTP", "http"],
    ["over stdio", "stdio"],
  ])(
    "exits with code 1 %s",
    async (_label, transport) => {
      for (const [name, value] of Object.entries(GOOD)) vi.stubEnv(name, value);
      vi.stubEnv("AUTH_MODE", "entra-keys");
      vi.stubEnv("MCP_TRANSPORT", transport);
      vi.stubEnv("MCP_OAUTH_ENABLED", "false");
      vi.spyOn(console, "error").mockImplementation(() => {});
      const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as () => never);

      vi.resetModules();
      await import("../index.js");

      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1), { timeout: 10_000 });
    },
    60_000,
  );
});

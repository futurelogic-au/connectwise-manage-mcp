/**
 * Tests for the origin allowlist on caller-supplied ConnectWise URLs (#101).
 *
 * gateway-url-guard.test.ts covers the shape, DNS and redirect rules. These
 * cover what the allowlist adds: only approved ConnectWise origins, and no
 * arbitrary port.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lookupMock = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

import { CwManageClient, type CwManageConfig } from "../api-client.js";
import { resolveGatewayConfig } from "../mcp-server.js";
import { assertSafeGatewayUrl } from "../url-guard.js";
import {
  ALLOWED_ORIGINS_ENV,
  DEFAULT_ALLOWED_ORIGINS,
  allowedOrigins,
  isAllowedOrigin,
} from "../url-allowlist.js";

function gatewayConfig(url: string): CwManageConfig {
  const headers: Record<string, string | undefined> = {
    "x-cw-company-id": "acme",
    "x-cw-public-key": "pub",
    "x-cw-private-key": "priv",
    "x-cw-client-id": "client-1",
    "x-cw-url": url,
  };
  return resolveGatewayConfig((name) => headers[name]).config!;
}

beforeEach(() => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: "203.0.113.10", family: 4 }]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("allowedOrigins", () => {
  it("holds the ConnectWise cloud origins by default", () => {
    expect([...allowedOrigins({})].sort()).toEqual([
      "https://api-au.myconnectwise.net",
      "https://api-eu.myconnectwise.net",
      "https://api-na.myconnectwise.net",
    ]);
  });

  it("adds the operator's origins, port included", () => {
    const origins = allowedOrigins({
      [ALLOWED_ORIGINS_ENV]: " https://cw.example.com , https://cw.example.com:8443/ ",
    });
    expect(origins.has("https://cw.example.com")).toBe(true);
    expect(origins.has("https://cw.example.com:8443")).toBe(true);
  });

  it.each([
    ["a wildcard", "*"],
    ["a wildcard host", "https://*.myconnectwise.net"],
    ["plain http", "http://cw.example.com"],
    ["a path", "https://cw.example.com/v4_6_release"],
    ["credentials", "https://user:pass@cw.example.com"],
    ["a query", "https://cw.example.com/?a=1"],
    ["a bare host name", "cw.example.com"],
  ])("drops an operator entry that is %s, and widens nothing", (_label, entry) => {
    const origins = allowedOrigins({ [ALLOWED_ORIGINS_ENV]: entry });
    expect([...origins].sort()).toEqual([...DEFAULT_ALLOWED_ORIGINS].sort());
  });

  it("matches on the whole origin, so a different port is a different origin", () => {
    expect(isAllowedOrigin(new URL("https://api-au.myconnectwise.net"), {})).toBe(true);
    expect(isAllowedOrigin(new URL("https://api-au.myconnectwise.net:443"), {})).toBe(true);
    expect(isAllowedOrigin(new URL("https://api-au.myconnectwise.net:8443"), {})).toBe(false);
  });
});

describe("assertSafeGatewayUrl with the origin allowlist", () => {
  it.each(DEFAULT_ALLOWED_ORIGINS.map((origin) => [origin]))("accepts %s", async (origin) => {
    await expect(assertSafeGatewayUrl(origin)).resolves.toBeUndefined();
  });

  it("accepts an approved origin that carries the API path", async () => {
    await expect(
      assertSafeGatewayUrl("https://api-au.myconnectwise.net/v4_6_release/apis/3.0"),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["a public host that is not ConnectWise", "https://evil.example"],
    ["a look-alike suffix", "https://api-au.myconnectwise.net.evil.example"],
    ["a look-alike prefix", "https://evil-api-au.myconnectwise.net"],
    ["another myconnectwise.net host", "https://internal.myconnectwise.net"],
    ["a trailing dot", "https://api-au.myconnectwise.net."],
    ["a loopback address", "https://127.0.0.1"],
    ["the loopback name", "https://localhost"],
    ["an IPv6 loopback address", "https://[::1]"],
    ["a private address", "https://10.0.0.5"],
    ["a link-local address", "https://169.254.10.10"],
    ["the cloud metadata address", "https://169.254.169.254"],
  ])("rejects %s without a DNS lookup", async (_label, url) => {
    await expect(assertSafeGatewayUrl(url)).rejects.toThrow(/not an approved ConnectWise origin/);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a high port", "https://api-au.myconnectwise.net:8443"],
    ["the plain HTTP port", "https://api-au.myconnectwise.net:80"],
    ["a port on an unknown host", "https://evil.example:444"],
  ])("rejects %s without a DNS lookup", async (_label, url) => {
    await expect(assertSafeGatewayUrl(url)).rejects.toThrow(/port that is not approved/);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("accepts a non-default port only when the operator approved that exact origin", async () => {
    vi.stubEnv(ALLOWED_ORIGINS_ENV, "https://cw.example.com:8443");

    await expect(assertSafeGatewayUrl("https://cw.example.com:8443")).resolves.toBeUndefined();
    await expect(assertSafeGatewayUrl("https://cw.example.com:9443")).rejects.toThrow(/port/);
    await expect(assertSafeGatewayUrl("https://cw.example.com")).rejects.toThrow(/not an approved/);
  });

  it("still rejects an approved origin whose name now resolves to a private address", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);

    await expect(assertSafeGatewayUrl("https://api-au.myconnectwise.net")).rejects.toThrow(
      /non-public/,
    );
  });
});

describe("CwManageClient with a gateway URL and the origin allowlist", () => {
  it("fetches from an approved ConnectWise origin", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ version: "x" }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    await new CwManageClient(gatewayConfig("https://api-au.myconnectwise.net")).get("/system/info");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api-au.myconnectwise.net/v4_6_release/apis/3.0/system/info",
    );
  });

  it.each([
    ["an unapproved public host", "https://evil.example"],
    ["an approved host on another port", "https://api-au.myconnectwise.net:8443"],
  ])("never fetches from %s, so no credentials leave", async (_label, url) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(new CwManageClient(gatewayConfig(url)).get("/system/info")).rejects.toThrow();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });
});

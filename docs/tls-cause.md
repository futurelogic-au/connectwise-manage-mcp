# TLS cause: why certificate checking was switched off

Finding for WS1 item 11 of the ConnectWise MCP tool batch runbook. Tested 12/10/2026 from
Stephan's workstation against `connectwise.futurelogic.com.au` (on-premises ConnectWise,
v2025.1.10693).

## Finding

**Certificate checking works today. No certificate fault exists, and no CA fix is needed.**
With checking on, every handshake to our ConnectWise origin is authorised, on both Node
versions that run the connector. The fix is to remove `CW_MANAGE_REJECT_UNAUTHORIZED=false`
from each connector entry. Do not add `NODE_EXTRA_CA_CERTS`.

The original failure cannot be reproduced, so its cause is an inference, not a
measurement. The evidence points away from the certificate and towards a fault in this
connector's own code, which has since been fixed. See "Why it was needed".

## The chain

The server sends two certificates. The third is in Node's bundled CA store.

| # | Subject | Issuer | Valid | SHA-256 fingerprint |
|---|---|---|---|---|
| 0 | `*.futurelogic.com.au` (also `futurelogic.com.au`) | RapidSSL TLS RSA CA G1 | 04/08/2026 to 18/02/2027 | `37:AB:17:BC:BC:0E:61:81:79:F1:79:F7:38:E0:E0:F4:D7:7A:A6:22:44:62:45:78:A4:F3:35:45:5A:54:E1:C0` |
| 1 | RapidSSL TLS RSA CA G1 (intermediate) | DigiCert Global Root G2 | 02/11/2017 to 02/11/2027 | `44:22:E9:63:EE:53:CD:58:CC:9F:85:CD:40:BF:5F:FE:C0:09:5F:DF:1A:15:45:35:66:1C:1C:06:BC:AD:C6:9B` |
| root | DigiCert Global Root G2 | self | to 15/01/2038 | In Node's bundled store, not sent by the server |

- Protocol: TLS 1.2, cipher `ECDHE-RSA-AES256-GCM-SHA384`.
- Address: `221.121.133.116`, the same from the internal DNS server and from `8.8.8.8`.
- OpenSSL 3.5.6: `Verify return code: 0 (ok)`.

## The exact error

**There is none.** With checking on:

| Test | Result |
|---|---|
| Node 24.14.0 `tls.connect`, `rejectUnauthorized: true`, ten times | Authorised 10 of 10 |
| Node 24.16.0 `tls.connect`, `rejectUnauthorized: true` | Authorised |
| OpenSSL `s_client` | Verify return code 0 |
| The connector's own client code, `GET /system/info`, checking on, dummy keys | HTTP 400 from ConnectWise |

The last row is the live read. A 400 for dummy keys is a normal ConnectWise answer, and it
can only arrive after a verified handshake. `NODE_TLS_REJECT_UNAUTHORIZED` and
`NODE_EXTRA_CA_CERTS` were both unset for every test.

To prove that checking was really on, the same client code read two hosts with
deliberately bad certificates. Both were refused:

| Host | Result |
|---|---|
| `self-signed.badssl.com` | `DEPTH_ZERO_SELF_SIGNED_CERT` |
| `incomplete-chain.badssl.com` | `UNABLE_TO_VERIFY_LEAF_SIGNATURE` |

**Limit of this proof.** This shell holds no ConnectWise keys, so the read was not
authenticated. The authenticated read with checking on belongs to WS2, after the flag is
removed.

## What was ruled out

| Candidate cause | Verdict | Evidence |
|---|---|---|
| TLS inspection by a security agent or proxy | **Ruled out** | The issuer is the public RapidSSL CA, and the chain verifies against Node's bundled store with no extra CA. An inspecting agent re-signs with its own CA, which Node's store does not hold. No proxy is set: WinHTTP is direct, the user proxy is off, and no proxy variable is in the environment |
| Missing intermediate | **Ruled out today** | The server sends the intermediate. A server that omits it gives `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, as the bad-certificate test shows |
| Stale Node CA store | **Ruled out** | DigiCert Global Root G2 is in the bundled store of both Node versions in use: 24.14.0 (144 roots) and 24.16.0 (145 roots) |
| Expired certificate | **Ruled out today** | The leaf runs to 18/02/2027 |
| Host name mismatch | **Ruled out** | The wildcard covers `connectwise.futurelogic.com.au` |

## Why it was needed

This part is inference. The dates are facts; the link between them is not proven.

| Date | Fact | Source |
|---|---|---|
| 14/07/2025 to 14/08/2026 | Previous wildcard certificate, same CA and same intermediate | Certificate Transparency log |
| 04/08/2026 | Current certificate issued | The certificate itself |
| 20/08/2026 | Upstream #57: the client began to pass a standalone `undici` Agent to Node's built-in fetch on every request, checking on or off | `git log`, commit `3e5d174` |
| 30/09/2026 | Upstream #91: "Every tool call failed in the packaged MCP bundle" because of that Agent. The Agent is now built only when the flag is `false` | commit `517473f` |
| 01/10/2026 | Our fix: with the flag `false`, requests go through `undici`'s own fetch, so the Agent and the fetch match | commit `7a5dd16` |

**Most likely cause: a code fault that looked like a TLS fault.** From 20/08/2026 to
30/09/2026 every request failed with a bare `fetch failed`. The real error was
`UND_ERR_INVALID_ARG`: Node's fetch refused an Agent built by a different `undici`
version. A bare `fetch failed` against an on-premises server reads like a certificate
problem, and the flag is the documented answer to one. Our fix of 01/10/2026 exists only
to make the flag-`false` path work, which suggests the flag was in the config by then.
The runbook records it as set on 10/10/2026. Both faults are fixed in `main`.

**Second candidate: the old certificate's last days.** The old certificate expired on
14/08/2026. If the new one was bound on the server after that date, checking would have
failed with `CERT_HAS_EXPIRED` until it was bound. Nothing on this machine records when
the server was changed.

Two facts would settle it, and neither is on this machine: the date the flag was first
added to the config, and the date the current certificate was bound on the ConnectWise
server.

## The fix

**Remove `CW_MANAGE_REJECT_UNAUTHORIZED=false` from each connector entry.** Nothing else.
This is WS2 step 3. WS2 step 4, "apply the TLS fix WS1 proved", has nothing to apply.

The running clients, by process check on 12/10/2026:

| Client | Node | Connector build |
|---|---|---|
| Claude Desktop | `C:\Program Files\nodejs\node.exe`, 24.16.0 | Release build |
| Codex | `C:\nvm4w\nodejs\node.exe`, 24.14.0 | Release build |

Both Node versions pass the checked handshake, so the fix holds for both clients. The
flag must come out of both connector entries.

Never set `NODE_TLS_REJECT_UNAUTHORIZED`. It switches checking off for the whole process.

## If checking fails after the flag is removed

1. Restore the flag, as the WS2 stop rule says, so the connector works again.
2. Read the error code from the connector log. Do not guess the cause.
3. Use this table.

| Error code | Cause | Action |
|---|---|---|
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | The server stopped sending the intermediate | Fix the certificate binding on the ConnectWise server. As a stopgap only, save the intermediate from `http://cacerts.rapidssl.com/RapidSSLTLSRSACAG1.crt` as PEM and point `NODE_EXTRA_CA_CERTS` at it |
| `CERT_HAS_EXPIRED` | The certificate expired | Renew and bind the certificate on the server. No client setting fixes this safely |
| `SELF_SIGNED_CERT_IN_CHAIN` | A TLS inspection agent is now in the path | Stop and report it. Do not trust the agent's CA without a decision |
| `ERR_TLS_CERT_ALTNAME_INVALID` | The host name does not match the certificate | Check the URL in the connector entry |
| `UND_ERR_INVALID_ARG`, or a bare `fetch failed` with no certificate code | Not TLS. The `undici` Agent fault | Confirm the release build is at or after commit `7a5dd16` |

## Dates to watch

- **18/02/2027, a Thursday.** The wildcard certificate expires. Renew and bind it before
  then, or checking fails with `CERT_HAS_EXPIRED`.
- **02/11/2027.** The RapidSSL intermediate expires. A renewed certificate will chain to a
  newer intermediate, and the server must send it.

## [Unreleased]

### Security

- **Upstream error bodies no longer reach the caller or the log (#104).** A failed ConnectWise response is now reported as `ConnectWise API {METHOD} {path} returned {status} (reference {id})`. The response body is not included, not kept on the error, and not logged. Each failure writes one log line with the method, path, status and the same reference. A 400 stays actionable: `code`, `message` and the per-field `errors` (`code`, `message`, `resource`, `field`) are copied through an allowlist with size limits. A 403 keeps `code` and `message` only, through the same allowlist, so the missing permission is still named. Each copied string is cleaned and capped at 200 characters. **Behaviour change:** Manage's message text for 401, 404 and 409 is no longer returned, and `CwApiError` no longer has a `body` property. Token exchange logging now records the status and the OAuth error code, never the raw Azure response.
- **Gateway `X-CW-Url` must name an approved ConnectWise origin (#101).** On top of the checks below, a caller-supplied URL must now match an allowlist: `https://api-na.myconnectwise.net`, `https://api-eu.myconnectwise.net` and `https://api-au.myconnectwise.net`, plus any origin the operator lists in `CW_MANAGE_ALLOWED_ORIGINS` (comma separated). An origin includes its port, so a port other than 443 passes only when that exact origin is listed. There is no wildcard. `CW_MANAGE_URL` in env mode is unchanged. **A gateway deployment that sends a self-hosted or tunnel URL must list that origin before it upgrades.**
- A malformed `Host` header no longer crashes the HTTP server (#102). The request listener and the OAuth `/authorize` route built a URL from the client-supplied `Host` value, so a value such as `[` threw and ended the process before any authentication ran. Request targets are now parsed against a fixed base, and an invalid `Host` or an invalid request target is answered with `400 invalid_request`.
- Refresh the lockfile to clear every known advisory in the production dependency graph (#103). `npm audit --omit=dev` now reports none. Lockfile only, within the declared ranges: `proxy-addr` 2.0.8, `@hono/node-server` 2.1.4, `hono` 4.13.13, `fast-uri` 3.1.8, `qs` 6.16.0, `ip-address` 10.7.4, `path-to-regexp` 8.4.2, `express-rate-limit` 8.7.1 and `body-parser` 2.3.0.
- **Gateway `X-CW-Url` is now validated before every request (#101).** The header is caller-controlled, and the server used to fetch whatever URL it held and follow redirects, so a gateway caller could reach loopback, private-network or cloud metadata addresses and read the response. A header URL must now be https with no credentials, query string or fragment, and every address its hostname resolves to must be public; the check re-runs on each request so a re-pointed hostname is caught. All requests now refuse redirects and time out after 30 seconds. `CW_MANAGE_URL` set by the operator is unchanged, so self-hosted servers on a private network keep working in env mode. Credit to [@gschellhas](https://github.com/gschellhas) for the report.
- Pin `fast-uri` to `^3.1.7` via an npm `overrides` entry. It reaches us transitively as `@modelcontextprotocol/sdk` → `ajv` → `fast-uri`, and the lockfile was resolving `3.1.0`, which is affected by seven high-severity advisories — host confusion via literal backslash ([GHSA-v2hh-gcrm-f6hx](https://github.com/advisories/GHSA-v2hh-gcrm-f6hx)), backslash authority introducer ([GHSA-7p8r-x3mc-p8w7](https://github.com/advisories/GHSA-7p8r-x3mc-p8w7)), percent-encoded authority delimiters ([GHSA-v39h-62p7-jpjc](https://github.com/advisories/GHSA-v39h-62p7-jpjc)), percent-encoded scheme normalization ([GHSA-jqff-g426-hqxp](https://github.com/advisories/GHSA-jqff-g426-hqxp)), path traversal via percent-encoded dot segments ([GHSA-q3j6-qgpj-74h6](https://github.com/advisories/GHSA-q3j6-qgpj-74h6)), failed IDN canonicalization ([GHSA-4c8g-83qw-93j6](https://github.com/advisories/GHSA-4c8g-83qw-93j6)), and SSRF via malformed IPv6 normalization ([GHSA-f65p-4m7j-42xc](https://github.com/advisories/GHSA-f65p-4m7j-42xc)). `ajv` validates tool input schemas on the request path, so this dependency is genuinely reachable. Credit to [@Tekscape-finance](https://github.com/Tekscape-finance) for spotting it; note that their `>=3.1.5` floor still leaves three of the seven advisories open, so we pin `^3.1.7`.

### Added

- **Booking delete.** `cw_delete_schedule_entry` deletes a wrong booking (`DELETE /schedule/entries/{id}`). It needs `confirm: true` and a `reason`. Only a future entry that is not done is deleted. A done entry, an entry that has started, an entry with time logged against it (a time entry for the same member on the same ticket inside the booking), and an entry not booked against a service ticket or a project ticket are refused with nothing written. After the delete it adds an internal note to the linked ticket naming the member, the original date and time in Perth time, and the reason, then reads the entry (expecting 404) and the note back. If the note cannot be added the response says the booking was deleted and gives the note text to add by hand. `cw_update_schedule_entry` no longer says there is no delete.
- **Ticket merge.** `cw_merge_tickets` merges up to 25 tickets into a parent as the ConnectWise merge does (`POST /service/tickets/{parentId}/merge` with `mergeTicketIds` and a closed `status`). It needs `confirm: true`. The parent and every child must be open and in the same company. The closed status is read from the children's board, never hard-coded: one closed status is used, and where the board has none or several the tool stops and lists them so the caller passes `statusId`. It adds an internal note on the parent listing what was merged and reads the parent and every child back.
- **Bulk ticket update.** `cw_bulk_update_tickets` applies one JSON Patch to up to 25 service tickets. It needs `confirm: true`: without it no request is made and the plan is returned. Tickets are updated one after another and one failure does not stop the rest. Each ticket gets one lean row (`id`, `summary`, `board`, `status`, `owner`, `company`, `_info.lastUpdated`), read back after the patch with a `verified` flag and any `mismatches` or `unchecked` paths. An optional `note` is added to each ticket as an internal note after its patch succeeds, and is never emailed. A failed ticket gets an error row with the status and reference only.
- **Lean ticket responses.** `cw_get_ticket` and `cw_update_ticket` take `lean: true` and return only `id`, `summary`, `board`, `status`, `owner`, `company` and `_info.lastUpdated`. Opt-in, so existing callers see no change. A lean `cw_get_ticket` carries no ticket card and reads no notes.
- **Ticket tasks, update.** `cw_update_ticket_task` patches one task on a service ticket (`PATCH /service/tickets/{ticketId}/tasks/{id}`). It changes `closedFlag` and `notes` only. It needs `confirm: true`: without it no request is made and the planned change is returned. After the write it reads the task back and returns that read, and it reports an error if the read does not match what was sent. There is no delete tool for ticket tasks.
- **Ticket tasks, read.** `cw_get_ticket_tasks` returns every task on a service ticket (`GET /service/tickets/{id}/tasks`), lean: `id`, `notes`, `closedFlag`, `priority` and `resolution`. It reads all pages and sorts by priority. Read-only.
- **Invoice update.** `cw_update_invoice` patches a single finance invoice via JSON Patch (`PATCH /finance/invoices/{id}`), documented alongside `cw_search_invoices` and `cw_get_invoice`. v1 allow-lists `status/id` / `status`, `attention`, `dueDate`, `date`, `reference`, `customerPO`, `internalNotes`, and `billToCompany` / `billingSite` (object or `/id`; `billToSite` accepted as an alias for `billingSite`; `billToContact` is rejected with a hint since Manage invoices don't have it); any other path is rejected before Manage is called. `dryRun` previews the patch against the current invoice with no write. Manage 4xx errors pass through unchanged; 429 is retried once with a short backoff, and 5xx is retried once only when every operation is replace. `CwManageClient` now throws a `CwApiError` (same message as before, plus `status`) so callers can branch on the HTTP code.
- **WYREAI-434.** `cw_update_contact` patches a contact (`PATCH /company/contacts/{id}`) with the same JSON Patch operations as `cw_update_ticket` and `cw_update_company` (`op` / `path` / `value`): `firstName`, `lastName`, `title`, `inactiveFlag`, `site`, `communicationItems` (email and phone), and `customFields`. Add/replace operations require `value` (RFC 6902), matching `cw_update_agreement_addition`. Contact types are a child collection (`typeIds` is create-only); `cw_update_contact_types` adds or removes a type such as "Decision Maker" via `/company/contacts/{id}/typeAssociations`.
- **Agreement addition update/create.** `cw_update_agreement_addition` patches an addition (line item) on an agreement via JSON Patch — quantity, effectiveDate, cancelledDate, billCustomer, and other fields — for cases like a weekly seat-count reconciliation against RMM/M365 counts. Its `dryRun` flag fetches the current addition, applies the patch in memory, and returns the would-be result without writing to Manage. `cw_create_agreement_addition` adds a new addition to an agreement (requires a catalog item ID and `billCustomer`). Addition field coverage was verified against a community-maintained ConnectWise Manage type reference, not the official REST docs directly — noted in the tool's own description.
- **WYREAI-400.** `cw_add_ticket_note` accepts `emailContactFlag`, `emailResourceFlag`, `emailCcFlag`, and `emailCc`. Nothing is emailed unless a flag is set. `cw_create_ticket` accepts `parentTicketId`. `cw_search_contacts` can filter by contact type (`typeName`, `typeId`, or `childConditions`) without pulling every contact. `cw_update_time_entry` and `cw_delete_time_entry` correct or remove time entries, including metered-agreement hours.
- **Finance, procurement and agreement-recap tools (10 new read-only tools).** Finance was the largest remaining gap in this server's coverage: an MSP finance team could read agreements and invoices but nothing about the buy side, the sell side, or agreement burn-down.
  - Procurement — `cw_search_purchase_orders`, `cw_get_purchase_order`, `cw_get_purchase_order_items`, `cw_search_procurement_products`, `cw_get_procurement_product`. Procurement *product items* are catalog SKUs instantiated onto a ticket, project, order or opportunity, carrying their own price, cost and margin; the catalog SKU definitions themselves remain under `cw_search_catalog_items`.
  - Sales orders — `cw_search_sales_orders`, `cw_get_sales_order`, `cw_get_sales_order_products`. `cw_get_sales_order_products` is always scoped to its order; any caller-supplied `conditions` are ANDed with that scope rather than replacing it, so the tool cannot be talked out of its own filter.
  - Agreement recaps — `cw_search_agreement_recaps`, `cw_get_agreement_recap`. The recap is the billing rollup ConnectWise computes per agreement (starting, used, remaining, available and overrun amounts, unbilled periods, last and next invoice), which answers burn-down and overage questions without summing additions by hand.
  - Every endpoint path was verified against ConnectWise's published OpenAPI contract ("Connectwise Manage Public Endpoints", 2025.16) rather than taken from the upstream forks, and each tool has a contract test that drives real MCP JSON-RPC and asserts the ConnectWise URL the tool actually builds (`src/__tests__/finance-procurement.test.ts`) — a tool can be registered, typecheck, and still call the wrong path. Two results of that check are pinned by tests and comments because they look like typos and are not: `/finance/agreementrecap/` is documented only *with* a trailing slash (the slash-less form appears nowhere in the contract) while its by-id sibling has none, and `ProductItem` carries a nested `salesOrder` reference with no flat `salesOrderId` companion, so the sales-order filter is `salesOrder/id=N`.
  - **Attribution.** The procurement, purchase-order and sales-order tools are derived from work by [@Tekscape-finance](https://github.com/Tekscape-finance) in the `Tekscape-finance/connectwise-manage-mcp` fork. The agreement-recap tools are derived from work by [@Cloudwize-Technologies](https://github.com/Cloudwize-Technologies) in the `Cloudwize-Technologies/connectwise-manage-mcp` fork. Both forks are Apache-2.0, as is this project. Thank you.
- **Interactive ticket card via MCP Apps (SEP-1865).** `cw_get_ticket` results now render as an interactive card in MCP Apps hosts (Claude Desktop/web, and other hosts advertising the `io.modelcontextprotocol/ui` extension), instead of a wall of JSON. The card shows status, priority, company, contact, owner, and board as human-readable labels, key dates, and recent notes — and includes a working "Add note" round-trip that calls `cw_add_ticket_note` from inside the card, defaulting to an internal-only (`internalAnalysisFlag`) note resolved server-side. Non-App hosts are unaffected: the tool's JSON payload is unchanged apart from a new `_card` field.
  - The two renderable tools advertise the UI via `_meta` (`ui/resourceUri`, plus the nested `ui.resourceUri` form) pointing at a new `ui://connectwise-manage/ticket-card.html` resource served as `text/html;profile=mcp-app`. The card HTML is a self-contained vite single-file bundle embedded at build time (`src/generated/ticket-card-html.ts`, committed), so it serves identically from stdio, Node HTTP, and the fs-less Cloudflare Workers runtime. The server now declares the `resources` capability and answers `resources/list` / `resources/read` (`src/resources.ts`).
  - The card is neutral by default (system fonts, no vendor identity, no external fetches) and brandable via `window.__BRAND__` injection or `MCP_BRAND_*` env vars (`MCP_BRAND_NAME`, `MCP_BRAND_LOGO_URL`, `MCP_BRAND_PRIMARY_COLOR`, `MCP_BRAND_ACCENT_COLOR`, `MCP_BRAND_BG`, `MCP_BRAND_TEXT`): at serve time the server replaces the card's BRAND_INJECT marker with an inline, `<`-escaped `window.__BRAND__` script, so self-hosters can theme the card without rebuilding. No brand configured = HTML served unchanged.

### Fixed

- **An inactive company is named, not passed through as a bare 400.** When ConnectWise refuses to save a service ticket with "This company is in a status that does not allow saving Service Ticket", `cw_update_ticket`, `cw_bulk_update_tickets`, `cw_create_ticket` and `cw_merge_tickets` now change nothing and return a message naming the company and its status. `cw_update_ticket` takes `newCompanyId` and `confirm`: with both, the patch is saved with the company changed in the same call. Without them the ticket is not moved. **Behaviour change:** a `cw_update_ticket` patch that changes the ticket's company (any path under `company`) now needs `confirm: true`.
- **The ticket card reads `structuredContent` (WYRE-AI #105).** `cw_get_ticket` sends the card as `_card` inside `structuredContent` and a one-line summary as `content[0].text`. The card bundle parsed the summary as JSON, so it never rendered. It now reads `structuredContent` first and keeps text parsing as a fallback. The extraction is `src/card-payload.ts`, shared by the bundle and the tests. The embedded UI resource (`src/generated/ticket-card-html.ts`) is rebuilt with the locked toolchain, so its diff against the previous bundle is the whole file. `scripts/embed-ui.mjs` now normalises line endings to LF, so a build on Windows embeds the same bytes as a build on Linux. A new test runs the embedded bundle against a fake MCP Apps host and checks what it renders: the previous bundle renders nothing for a result that carries the card only in `structuredContent`, and this one renders it.
- **`cw_add_ticket_note` email flags work on this ConnectWise version.** ConnectWise refuses `emailContactFlag`, `emailResourceFlag`, `emailCcFlag` and `emailCc` on a service note with 400 "Could not find member ... on object of type 'ServiceNote'", so the tool no longer sends them. A recipient flag is mapped to the ticket's `automaticEmailContactFlag`, `automaticEmailResourceFlag`, `automaticEmailCcFlag` and `automaticEmailCc` for that one note: the tool reads the ticket, sets the fields, posts the note with `processNotifications: true`, puts the ticket's values back and reads them to check. A recipient the caller did not name is forced off for that note. Every response carries an `email` block with a `sent` indicator and the recipients. ConnectWise does not report delivery, so `sent` means the note was posted with mail requested. **Behaviour change:** a note that will email now needs `confirm: true`; without it nothing is written and the plan is returned. A note that sends no mail is unchanged.
- **WYREAI-400.** Note create responses no longer echo both `internalFlag` and `externalFlag` on an internal-only note. `cw_search_contacts` no longer sends `types` / `types/name` (or a bare `name` field) as parent conditions, which Manage rejects with 400 `ApiFindCondition`.

### Changed

- Publish the package to the GitHub Packages npm registry (`npm.pkg.github.com`) on release: `@semantic-release/npm` `npmPublish` enabled and `publishConfig.registry` set.

### Documentation

- Clarify the "Deploy to Cloudflare Workers" / "Deploy to DigitalOcean" one-click flow: this server depends only on public npm packages, so the cloud builders install without any registry token. Installing the published package from GitHub Packages does require a GitHub PAT with `read:packages` (`export NODE_AUTH_TOKEN=$(gh auth token)`).

# [1.4.0](https://github.com/wyre-technology/connectwise-manage-mcp/compare/v1.3.0...v1.4.0) (2026-04-03)


### Features

* add finance agreements and sales opportunities tools ([886083f](https://github.com/wyre-technology/connectwise-manage-mcp/commit/886083f808e7034756703be04cf810e549e81894))

# [1.3.0](https://github.com/wyre-technology/connectwise-manage-mcp/compare/v1.2.1...v1.3.0) (2026-04-01)


### Bug Fixes

* resolve TypeScript errors in middleware tests for jose v6 ([f2fbf77](https://github.com/wyre-technology/connectwise-manage-mcp/commit/f2fbf77c29de332ed5d803f0d88b301a810c7624))


### Features

* add Entra ID OAuth 2.1 authentication layer ([ee9563d](https://github.com/wyre-technology/connectwise-manage-mcp/commit/ee9563d914a32ccb3304dfa2eb8d4d18eb8d8b8f))
* add ticket and project ticket notes tools ([9573d08](https://github.com/wyre-technology/connectwise-manage-mcp/commit/9573d087009a62fb51bc9616eaf690fa92e10026))

## [1.2.1](https://github.com/wyre-technology/connectwise-manage-mcp/compare/v1.2.0...v1.2.1) (2026-03-31)


### Bug Fixes

* **deploy:** replace node_compat with nodejs_compat for Wrangler v4 ([659fd01](https://github.com/wyre-technology/connectwise-manage-mcp/commit/659fd01b694baa081319430ca4dc810bfda5dca0))

## [1.1.5](https://github.com/wyre-technology/connectwise-manage-mcp/compare/v1.1.4...v1.1.5) (2026-03-02)


### Bug Fixes

* **ci:** fix broken YAML in Discord notification step ([f8412f1](https://github.com/wyre-technology/connectwise-manage-mcp/commit/f8412f1869c97929e0c218ab84cd78714ab5dfcb))
* **ci:** move Discord notification into release workflow ([9b439d0](https://github.com/wyre-technology/connectwise-manage-mcp/commit/9b439d01a3addb01d6a2e9c7c254fbfa91c597a3))

## [1.1.4](https://github.com/wyre-technology/connectwise-manage-mcp/compare/v1.1.3...v1.1.4) (2026-02-23)


### Bug Fixes

* quote MCPB bundle filename in release upload step and add debug listing ([50fe9ea](https://github.com/wyre-technology/connectwise-manage-mcp/commit/50fe9ea8b46b5cac308714544fc26fd39b0a3f4e))

## [1.1.3](https://github.com/wyre-technology/connectwise-manage-mcp/compare/v1.1.2...v1.1.3) (2026-02-18)


### Bug Fixes

* strip npm scope from MCPB bundle filename ([dd178af](https://github.com/wyre-technology/connectwise-manage-mcp/commit/dd178af6caabd7d3c231f362426244c9722264b4))

## [1.1.2](https://github.com/wyre-technology/connectwise-manage-mcp/compare/v1.1.1...v1.1.2) (2026-02-18)


### Bug Fixes

* convert pack-mcpb.js to ESM imports ([73733cb](https://github.com/wyre-technology/connectwise-manage-mcp/commit/73733cb73fbb53816aab6685b86fa532573a7019))

## [1.1.1](https://github.com/wyre-technology/connectwise-manage-mcp/compare/v1.1.0...v1.1.1) (2026-02-18)


### Bug Fixes

* **ci:** fix release workflow failures ([1f18198](https://github.com/wyre-technology/connectwise-manage-mcp/commit/1f18198616ab53a2a7adf6b4f7196071473504f4))

# [1.1.0](https://github.com/wyre-technology/connectwise-manage-mcp/compare/v1.0.1...v1.1.0) (2026-02-18)


### Features

* add MCPB bundle to release workflow ([a1107a2](https://github.com/wyre-technology/connectwise-manage-mcp/commit/a1107a2e52b2803d06d13b044f010e067e482949))
* add MCPB manifest for desktop installation ([05b49f5](https://github.com/wyre-technology/connectwise-manage-mcp/commit/05b49f5aed4d9cab02fa3f9954a33a9c47ebeb4a))
* add MCPB pack script ([2abb833](https://github.com/wyre-technology/connectwise-manage-mcp/commit/2abb83319dc932eed4a5f6f44272038781a74d2b))

# [1.1.0](https://github.com/wyre-technology/connectwise-manage-mcp/compare/v1.0.1...v1.1.0) (2026-02-17)


### Features

* add MCPB bundle to release workflow ([a1107a2](https://github.com/wyre-technology/connectwise-manage-mcp/commit/a1107a2e52b2803d06d13b044f010e067e482949))
* add MCPB manifest for desktop installation ([05b49f5](https://github.com/wyre-technology/connectwise-manage-mcp/commit/05b49f5aed4d9cab02fa3f9954a33a9c47ebeb4a))
* add MCPB pack script ([2abb833](https://github.com/wyre-technology/connectwise-manage-mcp/commit/2abb83319dc932eed4a5f6f44272038781a74d2b))

## [1.0.1](https://github.com/wyre-technology/connectwise-manage-mcp/compare/v1.0.0...v1.0.1) (2026-02-17)


### Bug Fixes

* **docker:** drop arm64 platform to fix QEMU build failures ([2c01732](https://github.com/wyre-technology/connectwise-manage-mcp/commit/2c01732ed3f4defc024dcddd95fba283ab92048c))

# 1.0.0 (2026-02-17)


### Bug Fixes

* add package-lock.json for npm ci in CI and Docker builds ([0fd9271](https://github.com/wyre-technology/connectwise-manage-mcp/commit/0fd927144f0261fd3d878d83d0c29646dd38c4ef))
* **ci:** fix duplicate step IDs, use Node 22 for semantic-release, drop Node 18 ([9aa7f4c](https://github.com/wyre-technology/connectwise-manage-mcp/commit/9aa7f4cc0c37bab59abf3a3a33776264be870acc))
* **ci:** remove npm cache (no package-lock.json in repo) ([d2e1c37](https://github.com/wyre-technology/connectwise-manage-mcp/commit/d2e1c3747728fbd1433f7eedb098b1c265606911))
* **deps:** add semantic-release and plugin devDependencies ([ad815b3](https://github.com/wyre-technology/connectwise-manage-mcp/commit/ad815b31fb312ab71feaa9c0236e2ba4e20e8834))
* escape newlines in .releaserc.json message template ([bc32d79](https://github.com/wyre-technology/connectwise-manage-mcp/commit/bc32d79115d5d1df84a785bd59c1b33ed38cb6a6))
* pass with no tests and add semantic-release devDependencies ([b8653f0](https://github.com/wyre-technology/connectwise-manage-mcp/commit/b8653f01b01ff2fe041aa9016e2980bf16b66a0a))
* regenerate package-lock.json with semantic-release deps ([92e5903](https://github.com/wyre-technology/connectwise-manage-mcp/commit/92e5903cbabc889467beb5090b7957d33b8b522b))
* regenerate package-lock.json with semantic-release deps ([5c54789](https://github.com/wyre-technology/connectwise-manage-mcp/commit/5c547897e8125d8d25c105b701006fff755bc7db))


### Features

* add mcpb packaging support ([50a58ac](https://github.com/wyre-technology/connectwise-manage-mcp/commit/50a58acdaee22db656cf4910223ad1a09e985067))
* add mcpb packaging support ([c14db0d](https://github.com/wyre-technology/connectwise-manage-mcp/commit/c14db0d92b7af5e1d9728e648e66d5900b18f0c8))
* add mcpb packaging support ([258863b](https://github.com/wyre-technology/connectwise-manage-mcp/commit/258863b365583d065cf1dfee0cad625fb036309f))
* add mcpb packaging support ([693b11c](https://github.com/wyre-technology/connectwise-manage-mcp/commit/693b11ccf95cdd4ab1262245728a4d525908706f))
* add mcpb packaging support ([71026b8](https://github.com/wyre-technology/connectwise-manage-mcp/commit/71026b815135b468cc0e912c52beba51ec0659c6))
* scaffold ConnectWise Manage MCP server with deploy infrastructure ([72b18a2](https://github.com/wyre-technology/connectwise-manage-mcp/commit/72b18a210605b5c74946d8df202ec2fae93dafd2))

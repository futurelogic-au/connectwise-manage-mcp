# ConnectWise Manage MCP Server

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)

**Let your AI assistant work directly with ConnectWise Manage.** Search tickets, log time, look up companies and contacts, manage projects — through natural conversation instead of clicking through the CWM interface.

This is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that gives Claude (or any MCP-compatible AI) 87 tools covering the daily operations ConnectWise Manage shops depend on. Works with both **cloud-hosted and self-hosted** CWM instances — just point it at your server.

> **Part of the [MSP Claude Plugins](https://github.com/wyre-technology/msp-claude-plugins) ecosystem** — a growing suite of AI integrations for the MSP stack including [Autotask](https://github.com/wyre-technology/autotask-mcp), [Datto RMM](https://github.com/wyre-technology/datto-rmm-mcp), [IT Glue](https://github.com/wyre-technology/itglue-mcp), [HaloPSA](https://github.com/wyre-technology/halopsa-mcp), [NinjaOne](https://github.com/wyre-technology/ninjaone-mcp), [Huntress](https://github.com/wyre-technology/huntress-mcp), and more. Built by MSPs, for MSPs.

## One-Click Deployment

[![Deploy to DO](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/WYRE-AI/connectwise-manage-mcp/tree/main)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/WYRE-AI/connectwise-manage-mcp)

> **Note on registry auth:** This server depends only on public npm packages, so the Cloudflare and DigitalOcean cloud builders install its dependencies anonymously — no token is required for one-click deploy. (If a future release adds a private `@wyre-ai/*` dependency, you would supply a GitHub PAT with `read:packages` as a build variable — `NODE_AUTH_TOKEN` for Cloudflare Workers, a build-time `GITHUB_TOKEN` secret for DigitalOcean.)
>
> **Installing the published package:** The released package is published to the [GitHub Packages](https://github.com/WYRE-AI/connectwise-manage-mcp/pkgs/npm/connectwise-manage-mcp) npm registry, which requires authentication on every install (even for public packages). To install it, authenticate npm to `npm.pkg.github.com` with a GitHub PAT that has `read:packages`:
>
> ```bash
> export NODE_AUTH_TOKEN=$(gh auth token)
> npm install @wyre-ai/connectwise-manage-mcp
> ```

For deploying to **Azure Container Apps** with Entra ID OAuth 2.1, see [AZURE_ACA_DEPLOYMENT.md](AZURE_ACA_DEPLOYMENT.md).

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CW_MANAGE_COMPANY_ID` | Yes | Your ConnectWise company identifier |
| `CW_MANAGE_PUBLIC_KEY` | Yes | API member public key |
| `CW_MANAGE_PRIVATE_KEY` | Yes | API member private key |
| `CW_MANAGE_CLIENT_ID` | Yes | Client ID from [ConnectWise Developer Portal](https://developer.connectwise.com/) |
| `CW_MANAGE_URL` | No | API base URL (see below) |
| `CW_MANAGE_REJECT_UNAUTHORIZED` | No | Set to `false` for self-signed certs (default: `true`) |
| `CW_MANAGE_ATTACH_ROOT` | No | Folder `cw_attach_document` may read a receipt from. Set per person, in that person's own connector entry. Unset, the tool refuses and reads nothing. A file outside the folder, including one reached through a link, is refused. See "Receipt folder" below |
| `MCP_TRANSPORT` | No | `stdio` (default) or `http` |
| `MCP_HTTP_PORT` | No | HTTP port (default: `8080`) |
| `AUTH_MODE` | No | `env` (default) or `gateway` for header-based auth |
| `CW_MANAGE_MEMBER_ID` | For expense tools | Your own ConnectWise member id. Set per person, in that person's own connector entry. Unset, the expense tools refuse and read and write nothing. See "Per-person settings for expense claims" below |

### Per-person settings for expense claims

The expense tools are limited to your own claims. Set these in the `env` block of your own connector entry, on your own machine:

```json
"CW_MANAGE_MEMBER_ID": "your-member-id"
```

- **`CW_MANAGE_MEMBER_ID` is per person.** It is your own ConnectWise member id, a whole number above zero. Every expense search, claim and receipt uses it as the member. It is never shared and never read from a request.
- **Unset, the expense tools refuse.** `cw_search_expense_entries`, `cw_create_expense_entry` and `cw_attach_document` return a message that names the variable, and read and write nothing. A `memberId` argument that differs from it is refused.
- **The connector does not look the member up.** `GET /system/myAccount` answers 404 on ConnectWise v2025.1, so the id comes from this variable and nowhere else.
- **Use it on a per-person install.** One process with one member id serves one person. Do not rely on the expense tools in a shared gateway deployment, where one process serves many callers.
- `CW_MANAGE_ATTACH_ROOT`, in the table above, is set the same way, per person in each connector entry.
- Restart the client after you set either. The connector reads its environment when it starts.

### API Base URL (`CW_MANAGE_URL`)

| Instance Type | URL |
|---------------|-----|
| Cloud (North America) | `https://api-na.myconnectwise.net` (default) |
| Cloud (Europe) | `https://api-eu.myconnectwise.net` |
| Cloud (Australia) | `https://api-au.myconnectwise.net` |
| **Self-hosted** | `https://cwm.yourcompany.com` |

For self-hosted instances, set `CW_MANAGE_URL` to your server's base URL. The server automatically appends `/v4_6_release/apis/3.0` unless the URL already contains that path.

If your self-hosted instance uses a self-signed certificate, also set `CW_MANAGE_REJECT_UNAUTHORIZED=false`.

### Getting Your API Keys

1. Log in to your ConnectWise Manage instance
2. Navigate to **System > Members > API Members**
3. Create a new API member with appropriate permissions
4. Generate API keys for the member
5. Get your Client ID from the [ConnectWise Developer Portal](https://developer.connectwise.com/)

## Available Tools

### Interactive Ticket Card (MCP Apps)

`cw_get_ticket` renders as an interactive card in MCP Apps hosts
(Claude Desktop/web). The card reads the `_card` payload from the tool result's
`structuredContent`, and falls back to parsing a text block. It has an in-card "Add note" round-trip via
`cw_add_ticket_note` that always posts internal-only (`internalAnalysisFlag`)
notes; plain-JSON behavior is unchanged in other hosts. The card is neutral by
default and brandable via `window.__BRAND__` injection or `MCP_BRAND_*` env
vars (`MCP_BRAND_NAME`, `MCP_BRAND_LOGO_URL`, `MCP_BRAND_PRIMARY_COLOR`,
`MCP_BRAND_ACCENT_COLOR`, `MCP_BRAND_BG`, `MCP_BRAND_TEXT`) — no rebuild
needed.

### Tickets
- `cw_search_tickets` — Search service tickets with conditions
- `cw_get_ticket`: Get a ticket by ID. Optional `lean: true` returns only `id`, `summary`, `board`, `status`, `owner`, `company` and `_info.lastUpdated`, with no ticket card
- `cw_get_ticket_configurations` — List configuration references associated with a service ticket (paged)
- `cw_update_ticket_configurations` — Add/remove ticket configuration associations in an ordered batch, reporting every outcome
- `cw_create_ticket` — Create a new service ticket. Optional `parentTicketId` (the same field `cw_get_ticket` returns) creates the ticket as a child of that parent.
- `cw_update_ticket`: Update a ticket (JSON Patch). Optional `lean: true` returns the lean shape above instead of the full saved ticket. A patch that changes the ticket's company needs `confirm: true`. If ConnectWise refuses the save because the company is in a status that does not allow saving a service ticket, nothing is changed and the reply names the company and its status; pass `newCompanyId` with `confirm: true` to save the patch and move the ticket in one call
- `cw_merge_tickets`: Merge up to 25 tickets into a parent, as the ConnectWise merge does (`POST /service/tickets/{id}/merge`). Needs `confirm: true`. Parent and children must be open and in the same company. The closed status for the merged tickets is read from their board: one closed status is used, otherwise the tool lists them and you pass `statusId`. Adds an internal note on the parent listing what was merged and reads everything back
- `cw_bulk_update_tickets`: Apply one JSON Patch to up to 25 tickets. Needs `confirm: true`; without it nothing is written and the plan is returned. Tickets run one after another and one failure does not stop the rest. The response gives `requested`, `succeeded` and `failed` counts with the rows, and is flagged as an error only when every row failed. Each ticket gets one lean row, read back after the patch, and an optional shared `note` is added as an internal note that is never emailed
- `cw_get_ticket_tasks`: Get every task on a ticket (the Tasks tab checklist), lean: `id`, `notes`, `closedFlag`, `priority`, `resolution`
- `cw_update_ticket_task`: Close, reopen or reword one task on a ticket. Changes `closedFlag` and `notes` only, needs `confirm: true`, and reads the task back. There is no delete tool for ticket tasks
- `cw_get_ticket_notes` — Get all notes on a ticket (including child ticket notes)
- `cw_add_ticket_note`: Add a note to a ticket (discussion, internal, or resolution). Optional `emailContactFlag`, `emailResourceFlag`, `emailCcFlag`, and `emailCc` control who is emailed. **Nothing is emailed unless one of those flags is set** (or you set `processNotifications`). Omitting them does not email the contact. A note that will email needs `confirm: true`. This ConnectWise version refuses recipient fields on a note, so the tool holds the matching `automaticEmail*` fields on the ticket for that one note, posts the note, puts the ticket's values back and reads them to check. A recipient you do not name is off for that note. Every response carries an `email` block with a `sent` indicator; ConnectWise does not report delivery, so `sent` means the note was posted with mail requested. The create response reports `internalFlag` / `externalFlag` from the note type that was stored, so an internal note is not also reported as external.

### Companies
- `cw_search_companies` — Search companies
- `cw_get_company` — Get a company by ID
- `cw_create_company` — Create a new company
- `cw_update_company`: Update a company (JSON Patch). It cannot change the company's types; a patch on `types` or `typeIds` is refused
- `cw_list_company_types`: List the company types ConnectWise holds, so a type name for the add is read, not guessed
- `cw_list_company_type_associations`: List the types a company holds (`GET /company/companies/{id}/typeAssociations`), with the association ID of each
- `cw_add_company_type_association`: Add a type by `typeId` or `typeName`. Needs `confirm: true`, skips a type the company already holds, and reads the types back
- `cw_remove_company_type_association`: Remove a type by `associationId`, `typeId` or `typeName`. Needs `confirm: true`, lists first, deletes only a matching association, and reads the types back

### Contacts
- `cw_search_contacts` — Search contacts. Filter contact type with `typeName`, `typeId`, or `childConditions` (for example `types/name = "Primary"`). `types` / `types/name` in `conditions` is invalid and returns 400 `ApiFindCondition` because type is a child collection; the tool moves those clauses to `childConditions`. Contacts have `firstName` and `lastName`, not `name`. String values use double quotes (`firstName = "Ada"`); single quotes are accepted and rewritten.
- `cw_get_contact` — Get a contact by ID
- `cw_create_contact` — Create a new contact
- `cw_update_contact` — Update a contact (JSON Patch on `PATCH /company/contacts/{id}`). Paths include `firstName`, `lastName`, `title`, `inactiveFlag`, `site`, `communicationItems` (email and phone), and `customFields`. Contact types are not on this patch.
- `cw_update_contact_types` — Add or remove a contact type such as "Decision Maker" (`POST` / `DELETE /company/contacts/{id}/typeAssociations`). Adding a type the contact already has does not create a duplicate.

### Projects
- `cw_search_projects` — Search projects
- `cw_get_project` — Get a project by ID
- `cw_create_project`: Create a new project. `billingMethod` (`ActualRates`, `FixedFee`, `NotToExceed` or `OverrideRate`) and `agreementId` (an agreement ID, or `null` for none) are required and have no default. `estimatedStart` and `estimatedEnd` (ISO 8601) are required too, because ConnectWise rejects a project without them: a call that leaves one out is refused before any request. Needs `confirm: true`, and reads the project back
- `cw_list_project_phases`: List the phases of a project, to find the `phaseId` a project ticket needs
- `cw_create_project_ticket`: Create a ticket on a project phase (`POST /project/tickets`). Needs `confirm: true`, checks the phase belongs to the project, and reads the ticket back
- `cw_search_project_tickets` — Search tickets under a project
- `cw_get_project_ticket` — Get a specific project ticket by ID
- `cw_get_project_ticket_notes` — Get all notes on a project ticket (including child ticket notes)
- `cw_add_project_ticket_note` — Add a note to a project ticket (discussion, internal, or resolution)

### Time Entries
- `cw_search_time_entries` — Search time entries
- `cw_get_time_entry` — Get a time entry by ID
- `cw_create_time_entry`: Create a new time entry. `billableOption` (`Billable`, `DoNotBill`, `NoCharge` or `NoDefault`) is set at creation, so no patch is needed. `timeSheetId` adds time to a submitted or past period, which ConnectWise otherwise refuses with "time period not open"; that refusal comes back as `reason: "time-period-not-open"` with the fix named. A closed ticket refuses new time: the tool says so and never reopens the ticket. Needs `confirm: true`; without it nothing is written and the planned body is returned
- `cw_update_time_entry` — Correct a time entry (JSON Patch on `PATCH /time/entries/{id}`). Use this to fix `actualHours` when a metered agreement rounds to 0.25.
- `cw_delete_time_entry` — Delete a time entry (`DELETE /time/entries/{id}`). Manage rejects deletes of entries that are already billed.

### Schedule Entries
- `cw_search_schedule_entries` — Search booked resource time
- `cw_list_schedule_types` — List schedule types (Service, Project, Sales, Meeting)
- `cw_list_schedule_statuses` — List schedule statuses (Tentative, Firm)
- `cw_create_schedule_entry` — Book resource time against a ticket, activity or project ticket
- `cw_update_schedule_entry` — Update a schedule entry (JSON Patch)
- `cw_delete_schedule_entry`: Delete a wrong booking. Needs `confirm: true` and a `reason`. Only a future entry that is not done is deleted: a done entry, a started entry, an entry with time logged against it, or an entry not booked against a service or project ticket is refused. After the delete it adds an internal note to the linked ticket naming the member, the original Perth date and time, and the reason, then reads the entry and the note back

### Members
- `cw_search_members` — Search members/technicians
- `cw_get_member` — Get a member by ID

### Configuration Items
- `cw_search_configurations` — Search configuration items (assets)
- `cw_get_configuration` — Get a configuration item by ID

### Service Reference Data
- `cw_list_boards` — List service boards
- `cw_list_priorities` — List ticket priorities
- `cw_list_statuses` — List statuses for a board

### Activities
- `cw_search_activities` — Search activities
- `cw_get_activity` — Get an activity by ID
- `cw_create_activity` — Create a new activity

### Agreements
- `cw_search_agreements` — Search agreements
- `cw_get_agreement` — Get an agreement by ID
- `cw_get_agreement_additions` — Get additions (line items) on an agreement
- `cw_update_agreement_addition` — Update an addition with JSON Patch (quantity, effectiveDate, cancelledDate, billCustomer, etc.); supports a `dryRun` preview that makes no write
- `cw_create_agreement_addition` — Create a new addition on an agreement
- `cw_search_agreement_additions`: Find every active addition carrying one catalog item, across all agreements of every type
- `cw_update_agreement_addition_product`: Repoint one addition to a different product, holding its billing values steady. **Changes live billing**, so it defaults to a dry run
- `cw_search_agreement_recaps` — Search agreement billing recaps (used, remaining, overrun, next invoice)
- `cw_get_agreement_recap` — Get the billing recap for one agreement
- `cw_list_agreement_exclusions`: List the work role and work type exclusions on an agreement, with the exclusion ID of each
- `cw_add_agreement_exclusion`: Exclude one work role or one work type from an agreement. Needs `confirm: true`, skips an exclusion already there, and reads the list back
- `cw_delete_agreement_exclusion`: Remove one exclusion row from an agreement, never the agreement. Needs `confirm: true`, lists first, and reads the list back

ConnectWise exposes additions only as children of a single agreement, with no cross-agreement additions endpoint, so `cw_search_agreement_additions` iterates agreements and queries each one. A full scan costs roughly one API call per agreement and is slow on a large instance: narrow it with `agreementConditions`, or set `maxAgreements` to sanity check the query first. Active agreements only by default, and additions whose `cancelledDate` has already passed are excluded unless asked for.

`cw_update_agreement_addition_product` repoints the product and, in the same PATCH, re-sends `unitPrice`, `unitCost`, `quantity`, `invoiceDescription`, `taxableFlag` and `billCustomer` at their pre-change values, because ConnectWise otherwise defaults them from the new catalog item and silently reprices the line. It reads the addition back afterwards and returns a before/after comparison of every field, flagging anything that changed other than the product. `dryRun` defaults to `true` and returns the planned PATCH without sending it.

### Expenses
- `cw_list_expense_types`: List expense types (inactive left out unless asked), with the ID the claim needs
- `cw_list_charge_codes`: List charge codes, for the `chargeCodeId` on a claim
- `cw_search_expense_entries`: Search the owner's own expense entries by date range and amount. Each row carries the entry's company. The member is your own, from `CW_MANAGE_MEMBER_ID`; another member's ID is refused, and with the variable unset nothing is read
- `cw_create_expense_entry`: Create one expense entry for the owner. `expenseTypeId` is required with no default. Every claim needs a charge-to: pass exactly one of `chargeCodeId` and `companyId`, with no default (neither, or both, is refused). A company is sent as the entry's company reference. `merchant` is required and written at the start of the notes (merchant `Ampol` with notes `Petrol` is stored as `Ampol, Petrol`). A duplicate check on date, amount and merchant runs first and a match is refused. Needs `confirm: true` and reads the entry back. There is no expense delete tool
- `cw_attach_document`: Attach a receipt (`.pdf`, `.png`, `.jpg`, `.jpeg`, at most 10 MiB) to one of the owner's expense entries through `POST /system/documents`. The file is read from disk under `CW_MANAGE_ATTACH_ROOT` and is never moved, renamed or filed. Needs `confirm: true`, skips a file already on the entry, and reads the entry's documents back

### Invoices
- `cw_search_invoices` — Search invoices (CW `conditions`, `orderBy` e.g. `id desc`)
- `cw_get_invoice` — Get an invoice by ID
- `cw_update_invoice` — Update one invoice with JSON Patch (`PATCH /finance/invoices/{id}`); returns the updated invoice in the same shape as `cw_get_invoice`. Allowed paths (leading slash optional): `status/id` or `status` (`{ id }`), `attention`, `dueDate`, `date`, `reference`, `customerPO`, `internalNotes`, `billToCompany` and `billingSite` (each as `{ id }` or via `/id`; `billToSite` is accepted as an alias for Manage's `billingSite`). Manage invoices have no `billToContact` field — use `attention` for the contact name. Custom and payment fields are rejected before Manage is called. `dryRun: true` GETs the invoice, applies the patch in memory, and returns `{ dryRun: true, saved: false, preview }` with no write. No batch mode — loop over ids (concurrency 3–5) and report per invoice. Resolve billing status names to ids first; never guess an id. Manage 400/401/403/404/409 errors pass through; 429 is retried once, and 5xx is retried once only when every operation is replace (a PATCH that includes add or remove retries only on 429). Requires the API member's role to have **Finance › Invoices: Edit**.

### Procurement
- `cw_search_purchase_orders` — Search purchase orders
- `cw_get_purchase_order` — Get a purchase order by ID
- `cw_get_purchase_order_items` — Get the line items on a purchase order
- `cw_search_procurement_products` — Search procurement product items (SKUs placed on a ticket, project, order or opportunity)
- `cw_get_procurement_product` — Get a procurement product item by ID

### Sales Orders
- `cw_search_sales_orders` — Search sales orders
- `cw_get_sales_order` — Get a sales order by ID
- `cw_get_sales_order_products` — Get the product items on a sales order

### Opportunities
- `cw_search_opportunities` — Search opportunities
- `cw_get_opportunity` — Get an opportunity by ID
- `cw_search_opportunity_forecasts` — Search opportunity forecast lines
- `cw_search_opportunity_notes` — Search notes on an opportunity
- `cw_search_sales_stages` — List sales pipeline stages

### Catalog (Products)
- `cw_search_catalog_items` — Search product catalog items
- `cw_get_catalog_item` — Get a catalog item by ID
- `cw_create_catalog_item` — Create a new catalog item
- `cw_update_catalog_item` — Update a catalog item (JSON Patch)
- `cw_list_catalog_categories` — List catalog categories
- `cw_list_catalog_subcategories` — List catalog subcategories
- `cw_list_manufacturers` — List manufacturers

### Procurement Inventory
Warehouse stock and Inventory Adjustments. An adjustment is the only supported way to change on-hand quantities through the API: create the header, add the lines, then close it to post.
- `cw_list_warehouses`: List inventory warehouses
- `cw_list_warehouse_bins`: List warehouse bins, optionally for one warehouse
- `cw_get_inventory_on_hand`: Report every item with non-zero on-hand per bin, negatives included, with unit cost and extended value
- `cw_list_adjustment_types`: List inventory adjustment types
- `cw_create_adjustment`: Create an adjustment header (moves no stock)
- `cw_add_adjustment_detail`: Add one signed adjustment line, with serial numbers for serialised items
- `cw_get_adjustment`: Get an adjustment header with all of its detail lines
- `cw_close_adjustment`: Post the adjustment. **Not reversible except by a counter-adjustment**

Two limits of the ConnectWise API are worth knowing before using these. There is no `summary` field on an adjustment: the free-text fields are `reason` (max 100 characters) and `notes`. And no endpoint exposes an average cost, so the `unitCost` reported by `cw_get_inventory_on_hand` is the catalog item's own `cost` field, which is the standing cost rather than the weighted average cost ConnectWise values the stock at.

### Health
- `cw_test_connection` — Test connection (hits `/system/info`)

## Usage

### With Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "connectwise-manage": {
      "command": "npx",
      "args": ["@wyre-ai/connectwise-manage-mcp"],
      "env": {
        "CW_MANAGE_COMPANY_ID": "your-company-id",
        "CW_MANAGE_PUBLIC_KEY": "your-public-key",
        "CW_MANAGE_PRIVATE_KEY": "your-private-key",
        "CW_MANAGE_CLIENT_ID": "your-client-id"
      }
    }
  }
}
```

For a self-hosted instance:

```json
{
  "mcpServers": {
    "connectwise-manage": {
      "command": "npx",
      "args": ["@wyre-ai/connectwise-manage-mcp"],
      "env": {
        "CW_MANAGE_URL": "https://cwm.yourcompany.com",
        "CW_MANAGE_COMPANY_ID": "your-company-id",
        "CW_MANAGE_PUBLIC_KEY": "your-public-key",
        "CW_MANAGE_PRIVATE_KEY": "your-private-key",
        "CW_MANAGE_CLIENT_ID": "your-client-id",
        "CW_MANAGE_REJECT_UNAUTHORIZED": "false"
      }
    }
  }
}
```

#### Receipt folder

`cw_attach_document` uploads a receipt to one of your own expense entries. It reads the file from disk, so it needs to be told where receipts live. Add `CW_MANAGE_ATTACH_ROOT` to the `env` block of your own connector entry, set to one folder of receipts:

```json
"CW_MANAGE_ATTACH_ROOT": "C:\\Users\\you\\Documents\\Expense Claims"
```

- **It is per person.** Each person sets it in their own connector entry, on their own machine, to their own folder. It is never shared, and it is never read from a request.
- **Unset, the tool refuses.** With no `CW_MANAGE_ATTACH_ROOT` the attach says so and reads nothing, so a receipt is never attached by accident.
- **Only that folder is read.** A file outside it, including one reached through a link, is refused. The file is read and never moved, renamed or changed.
- Restart the client after you set it. The connector reads its environment when it starts.

### With Docker

```bash
docker compose up -d
```

### HTTP Transport (Gateway Mode)

Run with HTTP transport for multi-tenant gateway deployments:

```bash
MCP_TRANSPORT=http AUTH_MODE=gateway node dist/index.js
```

Pass credentials per-request via headers: `X-CW-Company-Id`, `X-CW-Public-Key`, `X-CW-Private-Key`, `X-CW-Client-Id`, and optionally `X-CW-URL`.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run in development
npm run dev

# Type check
npm run typecheck

# Run tests
npm test
```

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

Apache-2.0

---

Built by [WYRE Technology](https://github.com/wyre-technology) — part of the [MSP Claude Plugins](https://github.com/wyre-technology/msp-claude-plugins) ecosystem

<!-- runbook-contracts: Daily-Catalyst-Runbook -->
Runbook: [[Daily-Catalyst-Runbook]] in the obsidian-Personal vault, WS2 adds ticket task tools here.

Standing stop rules:
- Do not stub ConnectWise. If credentials fail, stop and report what failed.
- Do not invent identifiers. Ids, names and paths come from the runbook or a live query.
- Report against the runbook acceptance table line by line.
- Never write a UTF-8 BOM. Read the first three bytes back.
- Australian English, no em dashes anywhere including code comments.
- Confirm before any external write.

Domain contracts:
- New tools: cw_get_ticket_tasks (GET service/tickets/{id}/tasks) and cw_update_ticket_task (PATCH service/tickets/{ticketId}/tasks/{id}, closedFlag and notes only).
- No delete operations on ticket tasks.
- Close only a task Stephan has named in the session.
- The consumer finds the open "Clearing the Decks" ticket on board 33 by summary, matched case-insensitively.
<!-- /runbook-contracts -->

<!-- runbook-contracts: ConnectWise-MCP-Tool-Batch-Runbook -->
Runbook: ConnectWise-MCP-Tool-Batch-Runbook in the FL-Leadership vault, 10-Projects/ConnectWise MCP Tool Batch/06-Runbooks. CW 904995.

Standing stop rules:
- Do not stub. If a dependency is missing, stop and report what is missing and what you would need. Never write fallback or sample data to make a test pass.
- Do not invent identifiers. Ids, names and paths come from the runbook, the spec, or a live query. If it is not in front of you, stop and ask.
- Report against the runbook acceptance table line by line, met or not met. Partial acceptance is not completion.
- Never write a UTF-8 BOM. Read the first three bytes back.
- Australian English, AUD, no em dashes anywhere including code comments.
- Confirm before any external write.

Domain contracts:
- One branch and one pull request per numbered item or group. Never merge, never force-push main.
- Every write tool takes confirm: true and reads the record back after the write.
- Every delete refuses a done record or one with time against it, and writes an internal CW ticket note naming what went and why.
- No delete tool on ticket tasks, expense entries or setup tables. No write tool on setup tables.
- Lean shape: id, summary, board, status, owner, company, _info.lastUpdated.
- Errors returned to the caller carry status and a reference id only, never the upstream body, a key or a token.
- TLS checking stays on by default. Never set NODE_TLS_REJECT_UNAUTHORIZED. Never widen the ConnectWise URL allowlist to pass a test.
- Each person runs on their own member's keys. A 403 is a stop: report it, never work around it.
- Live test writes only on Future Logic's own company (FLHQ, id 250) and internal CW tickets made for the test. Never a client record, never a real client contact.
- Status names are read from the board live, never hard-coded.
- Never read or edit the Claude Desktop config. Never paste or log a key.
- The ticket task contract lives in the other runbook-contracts block in this file. Build to it and do not edit that block.
<!-- /runbook-contracts -->

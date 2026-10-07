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

/**
 * Find the ticket card in an MCP tool result.
 *
 * Kept apart from ui/ticket-card.ts so the iframe bundle and the tests share
 * one implementation, and so the tests can run it without a browser. This file
 * has no imports at run time and no side effects.
 *
 * cw_get_ticket sends the card as `_card` inside `structuredContent`. Its
 * `content[0].text` is a one-line summary, not JSON (WYRE-AI issue #105). Text
 * parsing stays as a fallback for a host or server that sends the ticket JSON
 * as text.
 */
import type { TicketCard } from "./card.builder.js";

export interface ToolResultLike {
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
}

/** The card inside a payload, when it has the fields the renderer reads. */
export function extractCard(payload: unknown): TicketCard | null {
  const card = (payload as { _card?: TicketCard } | null | undefined)?._card;
  return card &&
    typeof card.id === "number" &&
    typeof card.summary === "string" &&
    Array.isArray(card.notes)
    ? card
    : null;
}

/** structuredContent first, then the first text block parsed as JSON. */
export function cardFromResult(result: ToolResultLike): TicketCard | null {
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    const card = extractCard(result.structuredContent);
    if (card) return card;
  }
  const text = (result.content ?? []).find((c) => c.type === "text")?.text;
  if (!text) return null;
  try {
    return extractCard(JSON.parse(text));
  } catch {
    return null;
  }
}

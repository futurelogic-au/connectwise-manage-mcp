/**
 * Runs the embedded ticket card bundle (src/generated/ticket-card-html.ts) the
 * way an MCP Apps host does, with a hand-written host and a minimal DOM, and
 * checks what it renders. This is the check for WYRE-AI #105: a string search of
 * the bundle cannot tell the fixed card from the broken one, because the MCP
 * SDK inside the bundle already mentions structuredContent.
 *
 * The host side speaks the MCP Apps JSON-RPC over postMessage: it answers
 * ui/initialize, then sends ui/notifications/tool-result with a result that has
 * a plain-text summary in content[0].text and the card in structuredContent,
 * which is exactly what cw_get_ticket returns.
 */

import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { TICKET_CARD_HTML } from "../generated/ticket-card-html.js";

/** The smallest DOM the card needs: elements that hold children, text and a few props. */
class FakeElement {
  children: unknown[] = [];
  className = "";
  id = "";
  type = "";
  placeholder = "";
  value = "";
  disabled = false;
  src = "";
  alt = "";
  textContent = "";
  style: Record<string, unknown> & { setProperty: () => void } = { setProperty: () => undefined };
  dataset: Record<string, string> = {};
  constructor(readonly tag: string) {}
  append(...nodes: unknown[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: unknown[]) {
    this.children = [...nodes];
  }
  addEventListener() {}
  setAttribute() {}
  querySelectorAll() {
    return [];
  }
  getBoundingClientRect() {
    return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  }
}

function textOf(node: unknown): string {
  if (typeof node === "string") return node;
  if (node instanceof FakeElement) {
    return [node.textContent, ...node.children.map(textOf)].join(" ");
  }
  return "";
}

interface HostResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
}

/** Load the bundle, connect it to a fake host, deliver one tool result, return the rendered text. */
async function renderCard(html: string, toolResult: HostResult): Promise<string> {
  const script = /<script type="module" crossorigin>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!script) throw new Error("The bundle has no module script");

  const root = new FakeElement("div");
  const listeners: Array<(event: { source: unknown; data: unknown }) => void> = [];
  const toHost: Array<{ method?: string; id?: number }> = [];
  const host: { postMessage: (message: { method?: string; id?: number }) => void } = {
    postMessage(message) {
      toHost.push(message);
      const reply = (data: unknown) =>
        queueMicrotask(() => listeners.forEach((listener) => listener({ source: host, data })));
      if (message.method === "ui/initialize") {
        reply({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: (message as { params?: { protocolVersion?: string } }).params
              ?.protocolVersion,
            hostInfo: { name: "test-host", version: "1.0.0" },
            hostCapabilities: {},
            hostContext: {},
          },
        });
      }
      if (message.method === "ui/notifications/initialized") {
        reply({
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: toolResult,
        });
      }
    },
  };

  const window = {
    __BRAND__: undefined,
    parent: host,
    addEventListener: (_type: string, listener: (event: { source: unknown; data: unknown }) => void) =>
      listeners.push(listener),
    removeEventListener: () => undefined,
    location: {
      href: "http://card.local/",
      origin: "http://card.local",
      pathname: "/",
      search: "",
    },
  };
  const document = {
    documentElement: new FakeElement("html"),
    head: new FakeElement("head"),
    body: new FakeElement("body"),
    createElement: (tag: string) => new FakeElement(tag),
    getElementById: () => root,
    querySelectorAll: () => [],
    addEventListener: () => undefined,
    readyState: "complete",
  };
  class MutationObserver {
    observe() {}
    disconnect() {}
  }
  class ResizeObserver {
    observe() {}
    disconnect() {}
  }

  const context = vm.createContext({
    window,
    document,
    location: window.location,
    MutationObserver,
    ResizeObserver,
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    self: window,
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    URL,
    AbortController,
    TextEncoder,
    TextDecoder,
    structuredClone,
  });
  // The script runs here as a classic script, so a bundle that mentions
  // import.meta (the older vite output did) gets a stand-in for it.
  vm.runInContext(script.replace(/import\.meta/g, '({url:"http://card.local/"})'), context);

  // Let the initialise handshake and the tool result go through.
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  return textOf(root);
}

describe("embedded ticket card bundle (WYRE-AI #105)", () => {
  const card = {
    id: 77,
    summary: "Server offline in the Perth office",
    status: "New",
    company: "Future Logic HQ",
    notes: [{ who: "SJenner", text: "Rebooted the host" }],
    noteDefaults: { internalAnalysisFlag: true },
  };

  it("embeds the same line endings on every platform", () => {
    expect(TICKET_CARD_HTML).not.toContain("\r");
  });

  it("renders the card when the card is only in structuredContent and the text is a summary", async () => {
    const text = await renderCard(TICKET_CARD_HTML, {
      content: [{ type: "text", text: "Ticket #77: Server offline in the Perth office (no priority, New)" }],
      structuredContent: { id: 77, summary: card.summary, _card: card },
    });
    expect(text).toContain("Server offline in the Perth office");
    expect(text).toContain("Future Logic HQ");
    expect(text).toContain("Rebooted the host");
  });

  it("still renders when only the text block carries the ticket JSON", async () => {
    const text = await renderCard(TICKET_CARD_HTML, {
      content: [{ type: "text", text: JSON.stringify({ id: 77, summary: card.summary, _card: card }) }],
    });
    expect(text).toContain("Server offline in the Perth office");
  });

  it("renders nothing for a result that has no card", async () => {
    const text = await renderCard(TICKET_CARD_HTML, {
      content: [{ type: "text", text: "Ticket #77" }],
      structuredContent: { id: 77, summary: "Lean ticket" },
    });
    expect(text.trim()).toBe("");
  });
});

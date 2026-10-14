import { JSDOM } from "jsdom";

/** Instala un DOM de jsdom como globals (document, HTMLInputElement, Event...). */
export function installDom(body: string): JSDOM {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { url: "https://jobs.example.com/apply" });
  const w = dom.window as unknown as Record<string, unknown>;
  const g = globalThis as unknown as Record<string, unknown>;
  for (const name of [
    "document", "window", "Node", "NodeFilter", "Element", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement",
    "HTMLSelectElement", "Event", "InputEvent", "FocusEvent", "KeyboardEvent", "MouseEvent"
  ]) {
    Object.defineProperty(g, name, { value: w[name], configurable: true, writable: true });
  }
  Object.defineProperty(g, "location", { value: dom.window.location, configurable: true, writable: true });
  return dom;
}

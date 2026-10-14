/**
 * Interfaz inyectada en la página (botón flotante + panel), aislada con Shadow DOM.
 *
 * - CSS encapsulado: ni los estilos del sitio alteran el panel ni el panel altera el sitio.
 * - Hoja de estilos "adoptada" (constructable stylesheet): a diferencia de un <style> inline,
 *   no la bloquea un CSP estricto del sitio (`style-src` sin 'unsafe-inline').
 * - Es una capa de presentación pura: no conoce los campos de la página. Las tarjetas se
 *   identifican con ids y las acciones se delegan en `AssistantUiHandlers`.
 */
import panelCss from "./assistant-ui.css";

const HOST_ID = "hirely-assistant-root";

export interface QuestionCard {
  readonly id: string;
  readonly label: string;
  readonly initialAnswer: string;
  /** 0‒1; solo si hay una respuesta guardada sugerida. */
  readonly similarity?: number;
}

export interface AssistantUiHandlers {
  onLaunch(): void;
  onUseAnswer(cardId: string, text: string): void;
  /** Devuelve `true` si se guardó correctamente. */
  onSaveAnswer(cardId: string, text: string): Promise<boolean>;
  onClosed(): void;
}

export interface AssistantUi {
  openPanel(): void;
  closePanel(): void;
  isPanelOpen(): boolean;
  setStatus(message: string, tone?: "info" | "error"): void;
  renderQuestions(cards: readonly QuestionCard[]): void;
  destroy(): void;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function adoptStyles(shadow: ShadowRoot): void {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(panelCss);
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement("style");
    style.textContent = panelCss;
    shadow.append(style);
  }
}

/**
 * Evita que los atajos de teclado y los manejadores de "clic fuera" del sitio reaccionen a
 * lo que ocurre dentro del panel (p. ej. teclear en nuestro textarea no debe disparar los
 * hotkeys de la página, ni pulsar "Usar respuesta" debe cerrar un modal del sitio).
 */
function isolateEvents(root: HTMLElement, onEscape?: () => void): void {
  for (const type of ["keydown", "keyup", "keypress"] as const) {
    root.addEventListener(type, event => {
      if (type === "keydown" && (event as KeyboardEvent).key === "Escape") onEscape?.();
      event.stopPropagation();
    });
  }
  for (const type of ["click", "mousedown", "pointerdown", "touchstart"] as const) {
    root.addEventListener(type, event => event.stopPropagation(), { passive: true });
  }
}

export function mountAssistantUi(handlers: AssistantUiHandlers): AssistantUi {
  document.getElementById(HOST_ID)?.remove();

  const host = document.createElement("div");
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: "closed" });
  adoptStyles(shadow);

  const fab = element("button", "fab", "H");
  fab.type = "button";
  fab.title = "Abrir Hirely";
  fab.setAttribute("aria-label", "Abrir Hirely");
  fab.addEventListener("click", () => handlers.onLaunch());

  const panel = element("aside", "panel");
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Asistente de Hirely");

  const head = element("div", "head");
  const closeButton = element("button", "close", "×");
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "Cerrar");
  head.append(element("strong", undefined, "Hirely"), closeButton);
  const status = element("p", "status");
  status.setAttribute("aria-live", "polite");
  const list = element("div", "list");
  const foot = element("p", "foot", "Revisa cada sugerencia antes de usarla. Hirely no envía el formulario.");
  panel.append(head, status, list, foot);

  shadow.append(fab, panel);
  isolateEvents(panel, () => api.closePanel());
  isolateEvents(fab);
  document.documentElement.append(host);

  const api: AssistantUi = {
    openPanel() {
      panel.hidden = false;
    },
    closePanel() {
      if (panel.hidden) return;
      panel.hidden = true;
      list.replaceChildren();
      status.textContent = "";
      handlers.onClosed();
    },
    isPanelOpen: () => !panel.hidden,
    setStatus(message, tone = "info") {
      status.textContent = message;
      status.dataset["tone"] = tone;
    },
    renderQuestions(cards) {
      list.replaceChildren();
      if (!cards.length) {
        list.append(element("p", "empty", "No encontramos preguntas abiertas vacías. Puedes cerrar este panel."));
        return;
      }
      for (const card of cards) list.append(renderCard(card, handlers, api));
    },
    destroy() {
      host.remove();
    }
  };

  closeButton.addEventListener("click", () => api.closePanel());
  return api;
}

function renderCard(card: QuestionCard, handlers: AssistantUiHandlers, ui: AssistantUi): HTMLElement {
  const section = element("section", "card");
  const badge = element(
    "div",
    "badge",
    card.similarity === undefined
      ? "No hay una respuesta guardada suficientemente parecida"
      : `Respuesta guardada sugerida · coincidencia aproximada ${Math.round(card.similarity * 100)}%`
  );

  const textarea = element("textarea");
  textarea.value = card.initialAnswer;
  textarea.placeholder = "Escribe o adapta tu respuesta aquí…";
  textarea.setAttribute("aria-label", `Respuesta para ${card.label}`);

  const use = element("button", "use", "Usar respuesta");
  use.type = "button";
  use.addEventListener("click", () => {
    const text = textarea.value.trim();
    if (!text) return ui.setStatus("Escribe una respuesta antes de insertarla.", "error");
    handlers.onUseAnswer(card.id, text);
  });

  const save = element("button", "save", "Guardar para después");
  save.type = "button";
  save.addEventListener("click", async () => {
    const text = textarea.value.trim();
    if (!text) return ui.setStatus("Escribe una respuesta antes de guardarla.", "error");
    save.disabled = true;
    if (await handlers.onSaveAnswer(card.id, text)) save.textContent = "Guardada ✓";
    else save.disabled = false;
  });

  const actions = element("div", "actions");
  actions.append(use, save);
  section.append(element("p", "label", card.label), badge, textarea, actions);
  return section;
}

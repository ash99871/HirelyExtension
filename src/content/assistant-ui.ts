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

/** Un dato que Hirely encontró para un campo y que la persona debe autorizar antes de llenarlo. */
export interface ConsentItem {
  readonly id: string;
  /** Nombre del campo tal como lo ve la persona. */
  readonly label: string;
  /** Valor que se llenaría. */
  readonly value: string;
  /** `false` para listas cerradas (<select>, opciones): solo se acepta o se quita. */
  readonly editable: boolean;
}

/** Lo que la persona autorizó: el id del dato y el valor final (quizá editado). */
export interface ConsentApproval {
  readonly id: string;
  readonly value: string;
}

export interface AssistantUiHandlers {
  onLaunch(): void;
  /** Devuelve `true` si la respuesta quedó escrita en la página (entonces su tarjeta se quita). */
  onUseAnswer(cardId: string, text: string): boolean;
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
  /**
   * Muestra los datos encontrados y espera la decisión. Resuelve con lo autorizado, o `null`
   * si la persona cancela o cierra el panel. Nada se llena antes de que esto resuelva.
   */
  requestConsent(items: readonly ConsentItem[]): Promise<ConsentApproval[] | null>;
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

  /** Decisión de autorización pendiente: se resuelve una sola vez (autorizar, cancelar o cerrar). */
  let pendingConsent: ((result: ConsentApproval[] | null) => void) | null = null;
  const settleConsent = (result: ConsentApproval[] | null): void => {
    const resolve = pendingConsent;
    pendingConsent = null;
    resolve?.(result);
  };

  const api: AssistantUi = {
    openPanel() {
      panel.hidden = false;
    },
    closePanel() {
      if (panel.hidden) return;
      panel.hidden = true;
      list.replaceChildren();
      status.textContent = "";
      settleConsent(null);
      handlers.onClosed();
    },
    isPanelOpen: () => !panel.hidden,
    setStatus(message, tone = "info") {
      status.textContent = message;
      status.dataset["tone"] = tone;
    },
    requestConsent(items) {
      settleConsent(null);
      delete panel.dataset["view"];
      list.replaceChildren(renderConsent(items, settleConsent));
      return new Promise(resolve => {
        pendingConsent = resolve;
      });
    },
    renderQuestions(cards) {
      settleConsent(null);
      delete panel.dataset["view"];
      list.replaceChildren();
      if (!cards.length) return showDone();
      // Al usar una respuesta, su tarjeta se va; cuando no queda ninguna, pantalla final.
      const answered = (): void => {
        if (!list.querySelector(".card")) showDone();
      };
      for (const card of cards) list.append(renderCard(card, handlers, api, answered));
    },
    destroy() {
      settleConsent(null);
      host.remove();
    }
  };

  /** Pantalla final: ya no quedan preguntas por responder. */
  function showDone(): void {
    panel.dataset["view"] = "done";
    status.textContent = "";
    list.replaceChildren(renderDone(() => api.closePanel()));
  }

  closeButton.addEventListener("click", () => api.closePanel());
  return api;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function checkIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.4");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M5 12.5l4.2 4.2L19 7");
  svg.append(path);
  return svg;
}

function renderDone(onClose: () => void): HTMLElement {
  const section = element("section", "done");
  const icon = element("div", "done-icon");
  icon.append(checkIcon());
  const close = element("button", "use done-close", "Cerrar");
  close.type = "button";
  close.addEventListener("click", onClose);
  const actions = element("div", "actions");
  actions.append(close);
  section.append(
    icon,
    element("p", "done-title", "Todo listo"),
    element("p", "done-text", "No detectamos más preguntas. Revisa el formulario y envíalo cuando quieras."),
    actions
  );
  return section;
}

/**
 * Lista de autorización: «Encontramos esta información para estos campos». Cada dato tiene su
 * casilla (marcada por defecto) y, si es texto libre, se puede corregir antes de autorizar.
 */
function renderConsent(items: readonly ConsentItem[], settle: (result: ConsentApproval[] | null) => void): HTMLElement {
  const section = element("section", "consent");
  section.append(
    element("p", "consent-title", "Encontramos esta información para estos campos"),
    element("p", "consent-hint", "Quita o corrige lo que no quieras antes de autorizar.")
  );

  const rows: { item: ConsentItem; check: HTMLInputElement; input: HTMLInputElement | null }[] = [];
  const table = element("div", "consent-list");
  for (const item of items) {
    const row = element("label", "consent-row");
    const check = element("input");
    check.type = "checkbox";
    check.checked = true;
    check.className = "consent-check";
    check.setAttribute("aria-label", `Llenar ${item.label}`);

    const body = element("span", "consent-body");
    body.append(element("span", "consent-label", item.label));
    let input: HTMLInputElement | null = null;
    if (item.editable) {
      input = element("input", "consent-value");
      input.type = "text";
      input.value = item.value;
      input.setAttribute("aria-label", `Valor para ${item.label}`);
      body.append(input);
    } else {
      body.append(element("span", "consent-fixed", item.value));
    }
    row.append(check, body);
    table.append(row);
    rows.push({ item, check, input });
  }

  const authorize = element("button", "use authorize");
  authorize.type = "button";
  const cancel = element("button", "save cancel", "Cancelar");
  cancel.type = "button";
  const toggle = element("button", "link toggle-all");
  toggle.type = "button";

  const refresh = (): void => {
    const count = rows.filter(row => row.check.checked).length;
    authorize.textContent = count ? `Autorizar y llenar (${count})` : "Autorizar y llenar";
    authorize.disabled = count === 0;
    toggle.textContent = count === rows.length ? "Quitar todos" : "Marcar todos";
  };
  for (const row of rows) row.check.addEventListener("change", refresh);
  toggle.addEventListener("click", () => {
    const all = rows.every(row => row.check.checked);
    for (const row of rows) row.check.checked = !all;
    refresh();
  });
  authorize.addEventListener("click", () => {
    const approved = rows
      .filter(row => row.check.checked)
      .map(row => ({ id: row.item.id, value: row.input ? row.input.value.trim() : row.item.value }))
      .filter(entry => entry.value !== "");
    if (approved.length) settle(approved);
  });
  cancel.addEventListener("click", () => settle(null));
  refresh();

  const actions = element("div", "actions");
  actions.append(authorize, cancel);
  section.append(toggle, table, actions);
  return section;
}

function renderCard(card: QuestionCard, handlers: AssistantUiHandlers, ui: AssistantUi, onAnswered: () => void): HTMLElement {
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
    if (!handlers.onUseAnswer(card.id, text)) return;
    // Respondida: la tarjeta se desvanece y se quita. Si era la última, aparece «Todo listo».
    use.disabled = true;
    section.classList.add("leaving");
    setTimeout(() => {
      section.remove();
      onAnswered();
    }, 200);
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

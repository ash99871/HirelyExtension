/**
 * Interfaz inyectada en la página (botón flotante + panel), aislada con Shadow DOM.
 *
 * - CSS encapsulado: ni los estilos del sitio alteran el panel ni el panel altera el sitio.
 * - Hoja de estilos "adoptada" (constructable stylesheet): a diferencia de un <style> inline,
 *   no la bloquea un CSP estricto del sitio (`style-src` sin 'unsafe-inline').
 * - Es una capa de presentación pura: no conoce los campos de la página. Las filas se
 *   identifican con ids y las decisiones se devuelven a `content.ts`.
 *
 * Flujo del panel: revisión («Encontramos esta información…» + «Necesitamos tu respuesta») →
 * la persona autoriza → (si algo quedó vacío) otra revisión → «Todo listo».
 */
import panelCss from "./assistant-ui.css";
import type { QuestionAnswer, QuestionKind, QuestionOption } from "../shared/form-questions";

const HOST_ID = "hirely-assistant-root";
/** Hasta este número de opciones se muestran como botones; con más, como lista desplegable. */
const MAX_CHIPS = 8;

/** Un dato que Hirely encontró para un campo y que la persona debe autorizar antes de llenarlo. */
export interface ConsentItem {
  readonly id: string;
  /** Nombre del campo tal como lo ve la persona. */
  readonly label: string;
  /** Valor que se llenaría. */
  readonly value: string;
  /** `false` para listas cerradas (<select>, opciones): solo se acepta o se quita. */
  readonly editable: boolean;
  /** Respuesta larga: se corrige en un área de texto. */
  readonly multiline?: boolean;
}

/** Lo que la persona autorizó: el id del dato y el valor final (quizá editado). */
export interface ConsentApproval {
  readonly id: string;
  readonly value: string;
}

/** Una pregunta que Hirely no sabe responder: la persona la responde en el panel. */
export interface AskItem {
  readonly id: string;
  readonly label: string;
  readonly kind: QuestionKind;
  readonly options: readonly QuestionOption[];
  readonly required: boolean;
  readonly optional: boolean;
  readonly sensitive: boolean;
  /** Lista con buscador sin opciones a la vista: se escribe y Hirely elige la más parecida. */
  readonly searchable: boolean;
  readonly inputType: string;
  /** Respuesta que ya viene escrita (una respuesta guardada muy parecida). */
  readonly initial?: QuestionAnswer;
  /** Respuesta guardada menos parecida: se ofrece con un botón, sin escribirla. */
  readonly suggestion?: { readonly answer: QuestionAnswer; readonly text: string };
  /** Aviso bajo la pregunta (p. ej. «No pudimos llenarlo…»). */
  readonly note?: string;
}

export interface ReviewRequest {
  readonly found: readonly ConsentItem[];
  readonly ask: readonly AskItem[];
  /** Título de las preguntas cuando no hay datos encontrados (p. ej. en la segunda revisión). */
  readonly askTitle?: string;
  readonly cancelLabel?: string;
}

export interface ReviewResult {
  readonly approvals: ConsentApproval[];
  readonly answers: QuestionAnswer[];
  /** Guardar las respuestas nuevas para la próxima vez. */
  readonly remember: boolean;
}

export interface DoneSummary {
  readonly title?: string;
  readonly text: string;
  /** Líneas cortas bajo el texto: lo que quedó vacío, archivos por adjuntar… */
  readonly details?: readonly string[];
}

export interface AssistantUiHandlers {
  onLaunch(): void;
  onClosed(): void;
}

export interface AssistantUi {
  openPanel(): void;
  closePanel(): void;
  isPanelOpen(): boolean;
  setStatus(message: string, tone?: "info" | "error"): void;
  /**
   * Muestra lo encontrado y lo que falta, y espera la decisión. Resuelve con lo autorizado y
   * respondido, o `null` si la persona cancela o cierra el panel. Nada se llena antes.
   */
  requestReview(request: ReviewRequest): Promise<ReviewResult | null>;
  /** Pantalla final con el resumen. */
  showDone(summary: DoneSummary): void;
  /** Pantalla para cuando la página no tiene nada que Hirely pueda llenar ni preguntar. */
  showNothingFound(): void;
  /** Aviso «Formulario detectado · N campos» (0 lo oculta). */
  setDetected(count: number): void;
  destroy(): void;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, text: string): HTMLButtonElement {
  const node = element("button", className, text);
  node.type = "button";
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
 * hotkeys de la página, ni pulsar un botón del panel debe cerrar un modal del sitio).
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

  const fab = button("fab", "H");
  fab.title = "Abrir Hirely";
  fab.setAttribute("aria-label", "Abrir Hirely");
  fab.addEventListener("click", () => handlers.onLaunch());

  // Aviso junto al botón cuando aparece un formulario con campos vacíos.
  const detected = button("detected", "");
  detected.hidden = true;
  detected.addEventListener("click", () => handlers.onLaunch());

  const panel = element("aside", "panel");
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Asistente de Hirely");

  const head = element("div", "head");
  const closeButton = button("close", "×");
  closeButton.setAttribute("aria-label", "Cerrar");
  head.append(element("strong", undefined, "Hirely"), closeButton);
  const status = element("p", "status");
  status.setAttribute("aria-live", "polite");
  const list = element("div", "list");
  const foot = element("p", "foot", "Revisa los datos antes de enviar. Hirely nunca envía el formulario.");
  panel.append(head, status, list, foot);

  shadow.append(detected, fab, panel);
  isolateEvents(panel, () => api.closePanel());
  isolateEvents(fab);
  isolateEvents(detected);
  document.documentElement.append(host);

  /** Decisión pendiente: se resuelve una sola vez (autorizar, cancelar o cerrar). */
  let pending: ((result: ReviewResult | null) => void) | null = null;
  const settle = (result: ReviewResult | null): void => {
    const resolve = pending;
    pending = null;
    resolve?.(result);
  };
  let detectedCount = 0;

  const api: AssistantUi = {
    openPanel() {
      panel.hidden = false;
      detected.hidden = true;
    },
    closePanel() {
      if (panel.hidden) return;
      panel.hidden = true;
      list.replaceChildren();
      status.textContent = "";
      delete panel.dataset["view"];
      settle(null);
      handlers.onClosed();
    },
    isPanelOpen: () => !panel.hidden,
    setStatus(message, tone = "info") {
      status.textContent = message;
      status.dataset["tone"] = tone;
    },
    requestReview(request) {
      settle(null);
      delete panel.dataset["view"];
      list.replaceChildren(renderReview(request, settle));
      return new Promise(resolve => {
        pending = resolve;
      });
    },
    showDone(summary) {
      settle(null);
      showEnd({ icon: CHECK_ICON, title: summary.title ?? "Todo listo", text: summary.text, details: summary.details ?? [] });
    },
    showNothingFound() {
      settle(null);
      showEnd(NOTHING_FOUND);
    },
    setDetected(count) {
      detectedCount = count;
      detected.textContent = `Formulario detectado · ${count} ${count === 1 ? "campo" : "campos"}`;
      detected.hidden = count === 0 || !panel.hidden;
      // Con el panel abierto en el resumen final, el aviso aparece dentro del panel.
      list.querySelector(".rescan")?.remove();
      if (count > 0 && !panel.hidden && panel.dataset["view"] === "done") {
        const again = button("use rescan", `Hay campos nuevos (${count}) · Revisarlos`);
        again.addEventListener("click", () => handlers.onLaunch());
        list.querySelector(".done")?.append(again);
      }
    },
    destroy() {
      settle(null);
      host.remove();
    }
  };

  function showEnd(screen: EndScreen): void {
    panel.dataset["view"] = "done";
    status.textContent = "";
    list.replaceChildren(renderEnd(screen, () => api.closePanel()));
    if (detectedCount > 0 && screen !== NOTHING_FOUND) api.setDetected(0);
  }

  closeButton.addEventListener("click", () => api.closePanel());
  return api;
}

/* ------------------------------ pantallas finales ------------------------------ */

const SVG_NS = "http://www.w3.org/2000/svg";

interface EndScreen {
  /** Trazos SVG (atributo d) del ícono, en una caja de 24×24. */
  readonly icon: readonly string[];
  readonly title: string;
  readonly text: string;
  readonly details: readonly string[];
}

const CHECK_ICON = ["M5 12.5l4.2 4.2L19 7"];

const NOTHING_FOUND: EndScreen = {
  icon: ["M10.5 4.5a6 6 0 1 0 0 12 6 6 0 0 0 0-12z", "M15 15l4.5 4.5"],
  title: "No encontramos campos aquí",
  text: "En esta página no hay campos vacíos. Abre el formulario que quieres llenar y vuelve a pulsar H.",
  details: []
};

function lineIcon(paths: readonly string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.4");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function renderEnd(screen: EndScreen, onClose: () => void): HTMLElement {
  const section = element("section", "done");
  const icon = element("div", "done-icon");
  icon.append(lineIcon(screen.icon));
  const close = button("use done-close", "Cerrar");
  close.addEventListener("click", onClose);
  const actions = element("div", "actions");
  actions.append(close);
  section.append(icon, element("p", "done-title", screen.title), element("p", "done-text", screen.text));
  if (screen.details.length) {
    const details = element("ul", "done-details");
    for (const line of screen.details) details.append(element("li", undefined, line));
    section.append(details);
  }
  section.append(actions);
  return section;
}

/* ------------------------------ revisión ------------------------------ */

interface FoundRow {
  readonly item: ConsentItem;
  readonly check: HTMLInputElement;
  readonly input: HTMLInputElement | HTMLTextAreaElement | null;
}

interface AskRow {
  readonly item: AskItem;
  read(): QuestionAnswer | null;
}

/**
 * «Encontramos esta información para estos campos» (datos del perfil, con casilla y valor
 * editable) + «Necesitamos tu respuesta» (lo que Hirely no sabe: se responde aquí mismo).
 */
function renderReview(request: ReviewRequest, settle: (result: ReviewResult | null) => void): HTMLElement {
  const root = element("div", "review");
  const foundRows: FoundRow[] = [];
  const askRows: AskRow[] = [];

  const authorize = button("use authorize", "");
  const cancel = button("save cancel", request.cancelLabel ?? "Cancelar");
  const refresh = (): void => {
    const count = foundRows.filter(row => row.check.checked).length + askRows.filter(row => row.read() !== null).length;
    authorize.textContent = count ? `Autorizar y llenar (${count})` : "Autorizar y llenar";
    authorize.disabled = count === 0;
    if (toggle) toggle.textContent = foundRows.every(row => row.check.checked) ? "Quitar todos" : "Marcar todos";
  };

  let toggle: HTMLButtonElement | null = null;
  if (request.found.length) {
    const section = element("section", "consent");
    section.append(
      element("p", "consent-title", "Encontramos esta información para estos campos"),
      element("p", "consent-hint", "Quita o corrige lo que no quieras antes de autorizar.")
    );
    toggle = button("link toggle-all", "");
    toggle.addEventListener("click", () => {
      const all = foundRows.every(row => row.check.checked);
      for (const row of foundRows) row.check.checked = !all;
      refresh();
    });
    const table = element("div", "consent-list");
    for (const item of request.found) {
      const row = element("label", "consent-row");
      const check = element("input");
      check.type = "checkbox";
      check.checked = true;
      check.className = "consent-check";
      check.setAttribute("aria-label", `Llenar ${item.label}`);
      check.addEventListener("change", refresh);

      const body = element("span", item.multiline ? "consent-body multiline" : "consent-body");
      body.append(element("span", "consent-label", item.label));
      let input: HTMLInputElement | HTMLTextAreaElement | null = null;
      if (item.editable) {
        input = item.multiline ? element("textarea", "consent-value") : element("input", "consent-value");
        if (input instanceof HTMLInputElement) input.type = "text";
        input.value = item.value;
        input.setAttribute("aria-label", `Valor para ${item.label}`);
        body.append(input);
      } else {
        body.append(element("span", "consent-fixed", item.value));
      }
      row.append(check, body);
      table.append(row);
      foundRows.push({ item, check, input });
    }
    section.append(toggle, table);
    root.append(section);
  }

  if (request.ask.length) {
    const section = element("section", "ask");
    const title = request.found.length ? "Necesitamos tu respuesta" : request.askTitle ?? "Necesitamos tu respuesta";
    section.append(
      element("p", "consent-title", title),
      element("p", "consent-hint", "Responde aquí y nosotros lo escribimos en el formulario. Lo que dejes en blanco no se toca.")
    );
    const table = element("div", "ask-list");
    for (const item of request.ask) {
      const row = renderAskRow(item, refresh);
      askRows.push(row.row);
      table.append(row.element);
    }
    section.append(table);
    root.append(section);
  }

  // Recordar las respuestas nuevas (nunca las sensibles).
  let remember: HTMLInputElement | null = null;
  if (request.ask.some(item => !item.sensitive)) {
    const label = element("label", "remember");
    remember = element("input");
    remember.type = "checkbox";
    remember.checked = true;
    label.append(remember, element("span", undefined, "Recordar mis respuestas para la próxima vez"));
    root.append(label);
  }

  authorize.addEventListener("click", () => {
    const approvals = foundRows
      .filter(row => row.check.checked)
      .map(row => ({ id: row.item.id, value: row.input ? row.input.value.trim() : row.item.value }))
      .filter(entry => entry.value !== "");
    const answers = askRows.map(row => row.read()).filter((answer): answer is QuestionAnswer => answer !== null);
    if (approvals.length || answers.length) settle({ approvals, answers, remember: remember?.checked ?? false });
  });
  cancel.addEventListener("click", () => settle(null));
  refresh();

  const actions = element("div", "actions");
  actions.append(authorize, cancel);
  root.append(actions);
  return root;
}

function tagsFor(item: AskItem): HTMLElement[] {
  const tags: HTMLElement[] = [];
  if (item.required) tags.push(element("span", "tag required", "Obligatorio"));
  else if (item.optional) tags.push(element("span", "tag", "Opcional"));
  if (item.sensitive) tags.push(element("span", "tag sensitive", "Dato sensible · no se guarda"));
  return tags;
}

const INPUT_MODE: Readonly<Record<string, string>> = { tel: "tel", number: "numeric", email: "email", url: "url" };

/** Una pregunta con el control adecuado: texto, área de texto, botones de opción o lista. */
function renderAskRow(item: AskItem, onChange: () => void): { element: HTMLElement; row: AskRow } {
  const container = element("div", "ask-row");
  container.dataset["kind"] = item.kind;
  const head = element("div", "ask-head");
  head.append(element("span", "ask-label", item.label), ...tagsFor(item));
  container.append(head);

  let read: () => QuestionAnswer | null;
  let apply: (answer: QuestionAnswer) => void;

  if (item.kind === "choice" || item.kind === "multi") {
    if (item.kind === "choice" && item.options.length > MAX_CHIPS) {
      // Muchas opciones: lista desplegable dentro del panel.
      const select = element("select", "ask-select");
      select.setAttribute("aria-label", item.label);
      select.append(new Option("Elige una opción", ""));
      for (const option of item.options) select.append(new Option(option.label, option.id));
      select.addEventListener("change", onChange);
      container.append(select);
      read = () => (select.value ? { id: item.id, optionIds: [select.value] } : null);
      apply = answer => {
        select.value = answer.optionIds?.[0] ?? "";
      };
    } else {
      const group = element("div", "chips");
      group.setAttribute("role", item.kind === "multi" ? "group" : "radiogroup");
      group.setAttribute("aria-label", item.label);
      const chips = new Map<string, HTMLButtonElement>();
      for (const option of item.options) {
        const chip = button("chip", option.label);
        chip.setAttribute("aria-pressed", "false");
        chip.addEventListener("click", () => {
          const pressed = chip.getAttribute("aria-pressed") === "true";
          // Una sola opción: elegir otra quita la anterior; pulsar la elegida la quita.
          if (item.kind === "choice") for (const other of chips.values()) other.setAttribute("aria-pressed", "false");
          chip.setAttribute("aria-pressed", String(!pressed));
          onChange();
        });
        chips.set(option.id, chip);
        group.append(chip);
      }
      if (item.kind === "multi") container.append(element("p", "ask-hint", "Puedes elegir varias."));
      container.append(group);
      read = () => {
        const ids = [...chips].filter(([, chip]) => chip.getAttribute("aria-pressed") === "true").map(([id]) => id);
        return ids.length ? { id: item.id, optionIds: ids } : null;
      };
      apply = answer => {
        for (const [id, chip] of chips) chip.setAttribute("aria-pressed", String(answer.optionIds?.includes(id) ?? false));
      };
    }
  } else if (item.kind === "checkbox") {
    const label = element("label", "ask-check");
    const box = element("input");
    box.type = "checkbox";
    box.addEventListener("change", onChange);
    label.append(box, element("span", undefined, "Marcar esta casilla"));
    container.append(label);
    read = () => (box.checked ? { id: item.id, checked: true } : null);
    apply = answer => {
      box.checked = answer.checked === true;
    };
  } else {
    const field = item.kind === "long-text" ? element("textarea", "ask-input") : element("input", "ask-input");
    if (field instanceof HTMLInputElement) {
      field.type = "text";
      const mode = INPUT_MODE[item.inputType];
      if (mode) field.inputMode = mode;
    }
    field.placeholder = item.kind === "date"
      ? "DD/MM/AAAA"
      : item.searchable
        ? "Escribe y elegimos la opción más parecida"
        : "Tu respuesta";
    field.setAttribute("aria-label", item.label);
    field.addEventListener("input", onChange);
    container.append(field);
    read = () => (field.value.trim() ? { id: item.id, text: field.value.trim() } : null);
    apply = answer => {
      field.value = answer.text ?? "";
    };
  }

  if (item.initial) {
    apply(item.initial);
    container.append(element("p", "ask-hint", "Respuesta tomada de tus respuestas guardadas."));
  } else if (item.suggestion) {
    const use = button("link use-saved", `Usar mi respuesta guardada: «${item.suggestion.text.slice(0, 60)}»`);
    use.addEventListener("click", () => {
      apply(item.suggestion!.answer);
      use.remove();
      onChange();
    });
    container.append(use);
  }
  if (item.note) container.append(element("p", "ask-note", item.note));
  return { element: container, row: { item, read: () => read() } };
}

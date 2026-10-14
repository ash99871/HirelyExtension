/**
 * ÚNICO módulo que toca los elementos de formulario de la página:
 *   1. Escaneo: DOM → `FieldDescriptor[]` (datos planos que consume la lógica de negocio).
 *   2. Llenado: escribir un valor y simular los eventos que esperan React/Angular/Vue.
 *
 * La lógica de negocio (src/shared/*) nunca ve un Element.
 */
import type { FieldDescriptor, FieldKind, FieldMatch, FieldOption } from "../shared/types";
import { yieldToMain } from "./scheduling";

export type FillableElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

export interface FormScan {
  readonly fields: FieldDescriptor[];
  /** id de descriptor → elemento real. Vive solo mientras dure la ejecución del asistente. */
  readonly elements: ReadonlyMap<string, FillableElement>;
  /** `true` si se alcanzó MAX_FIELDS y se ignoró el resto. */
  readonly truncated: boolean;
}

const CANDIDATE_SELECTOR = [
  "input:not([type=hidden]):not([type=password]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=image]):not([type=reset])",
  "textarea",
  "select"
].join(",");

const MAX_FIELDS = 400;
const MAX_OPTIONS = 400;
const MAX_LABEL_LENGTH = 300;
/** Presupuesto de trabajo continuo antes de ceder el hilo a la página. */
const SLICE_BUDGET_MS = 8;
const LABEL_SKIP_TAGS: ReadonlySet<string> = new Set(["SELECT", "TEXTAREA", "INPUT", "BUTTON", "OPTION", "SCRIPT", "STYLE"]);
const NEUTRAL_AUTOCOMPLETE: ReadonlySet<string> = new Set(["on", "off", "nope", "new-password"]);

/* ----------------------------- escaneo ----------------------------- */

function isSelect(element: FillableElement): element is HTMLSelectElement {
  return element.localName === "select";
}
function isTextarea(element: FillableElement): element is HTMLTextAreaElement {
  return element.localName === "textarea";
}
function isInput(element: FillableElement): element is HTMLInputElement {
  return element.localName === "input";
}

function kindOf(element: FillableElement): FieldKind {
  return isSelect(element) ? "select" : isTextarea(element) ? "textarea" : "input";
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH);
}

/**
 * Texto visible de un nodo ignorando controles anidados. Un <label> que envuelve un <select>
 * con 200 países no debe aportar los 200 países a la etiqueta; y se usa textContent
 * (no innerText) para no forzar un reflow del layout por cada campo.
 */
function visibleText(root: Element): string {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: node =>
      node.nodeType === Node.ELEMENT_NODE
        ? LABEL_SKIP_TAGS.has((node as Element).tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP
        : NodeFilter.FILTER_ACCEPT
  });
  let out = "";
  for (let node = walker.nextNode(); node && out.length < MAX_LABEL_LENGTH; node = walker.nextNode()) {
    out += ` ${node.nodeValue ?? ""}`;
  }
  return out;
}

interface LabelContext {
  readonly labels: ReadonlyMap<string, readonly HTMLLabelElement[]>;
  readonly ids: ReadonlyMap<string, Element>;
}

/**
 * `label[for]` indexados UNA vez por escaneo. `element.labels` recorre el árbol por cada campo
 * (O(campos × etiquetas)): con 400 campos tardaba ~8 s en jsdom frente a ~6 ms con el índice.
 */
function buildLabelContext(root: ParentNode): LabelContext {
  const labels = new Map<string, HTMLLabelElement[]>();
  const ids = new Map<string, Element>();
  for (const element of root.querySelectorAll<Element>("[id]")) {
    if (element.id && !ids.has(element.id)) ids.set(element.id, element);
  }
  for (const label of root.querySelectorAll<HTMLLabelElement>("label[for]")) {
    const target = label.htmlFor;
    if (!target) continue;
    const list = labels.get(target);
    if (list) list.push(label);
    else labels.set(target, [label]);
  }
  return { labels, ids };
}

function readLabel(element: FillableElement, context: LabelContext): string {
  const parts: string[] = [];
  const seen = new Set<Element>();
  const add = (node: Element | null): void => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    const text = visibleText(node);
    if (text.trim()) parts.push(text);
  };
  if (element.id) for (const label of context.labels.get(element.id) ?? []) add(label);
  const wrapping = element.closest("label");
  // Un <label for="otro"> que envuelve al control NO lo etiqueta.
  if (wrapping && (!wrapping.htmlFor || wrapping.htmlFor === element.id)) add(wrapping);
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) for (const id of labelledBy.split(/\s+/)) if (id) add(context.ids.get(id) ?? null);
  const aria = element.getAttribute("aria-label");
  if (aria) parts.push(aria);
  const placeholder = element.getAttribute("placeholder");
  if (placeholder) parts.push(placeholder);

  // Muchos componentes de Magneto dibujan el texto del campo en un nodo hermano,
  // no en <label>, aria-label o placeholder. En Shadow DOM buscamos el contenedor
  // más cercano con texto breve, sin tomar el texto de todo el formulario.
  if (parts.length === 0) {
    let ancestor = element.parentElement;
    for (let depth = 0; ancestor && depth < 3; depth++, ancestor = ancestor.parentElement) {
      const text = squash(visibleText(ancestor));
      if (text && text.length <= 120) {
        parts.push(text);
        break;
      }
    }
  }
  return squash(parts.join(" "));
}

function readHints(element: FillableElement): string {
  const autocomplete = element.getAttribute("autocomplete")?.trim().toLowerCase() ?? "";
  return squash([
    element.getAttribute("name") ?? "",
    element.id,
    NEUTRAL_AUTOCOMPLETE.has(autocomplete) ? "" : autocomplete
  ].join(" "));
}

function readOptions(select: HTMLSelectElement): FieldOption[] {
  const options: FieldOption[] = [];
  for (const option of select.options) {
    if (options.length >= MAX_OPTIONS) break;
    options.push({ value: option.value, label: option.label || option.text });
  }
  return options;
}

/** `checkVisibility` (Chrome 105+) descarta display:none/visibility:hidden: evita rellenar honeypots. */
function isRendered(element: Element): boolean {
  if (element.getAttribute("aria-hidden") === "true") return false;
  const check = (element as Element & { checkVisibility?: () => boolean }).checkVisibility;
  return typeof check === "function" ? check.call(element) : true;
}

function isUsable(element: FillableElement): boolean {
  if (element.disabled) return false;
  if (!isSelect(element) && element.readOnly) return false;
  return isRendered(element);
}

function describeElement(element: FillableElement, id: string, labelIndex: LabelContext): FieldDescriptor {
  return {
    id,
    kind: kindOf(element),
    inputType: isInput(element) ? element.type.toLowerCase() : "",
    label: readLabel(element, labelIndex),
    hints: readHints(element),
    value: element.value,
    options: isSelect(element) ? readOptions(element) : [],
    maxLength: isSelect(element) ? -1 : element.maxLength,
    size: isInput(element) ? element.size : 0
  };
}

/**
 * Recorre el formulario en lotes de ~8 ms cediendo el hilo entre ellos, para que un formulario
 * enorme no congele la página. Máximo MAX_FIELDS campos por ejecución.
 */
export async function scanFormFields(root: ParentNode = document): Promise<FormScan> {
  const fields: FieldDescriptor[] = [];
  const elements = new Map<string, FillableElement>();
  let truncated = false;
  let sliceStart = performance.now();

  // Recorre el documento y los Shadow DOM ABIERTOS. querySelectorAll no atraviesa
  // los límites de Shadow DOM por sí solo, por lo que Magneto parecía no tener campos.
  const roots: ParentNode[] = [root];
  const visited = new Set<ParentNode>([root]);
  const collectShadowRoots = (current: ParentNode): void => {
    for (const host of current.querySelectorAll<Element>("*")) {
      const shadow = host.shadowRoot;
      if (shadow && !visited.has(shadow)) {
        visited.add(shadow);
        roots.push(shadow);
        collectShadowRoots(shadow);
      }
    }
  };
  collectShadowRoots(root);

  for (const currentRoot of roots) {
    const labelContext = buildLabelContext(currentRoot);
    for (const element of currentRoot.querySelectorAll<FillableElement>(CANDIDATE_SELECTOR)) {
      if (fields.length >= MAX_FIELDS) {
        truncated = true;
        break;
      }
      if (!isUsable(element)) continue;
      const id = `hf-${fields.length + 1}`;
      fields.push(describeElement(element, id, labelContext));
      elements.set(id, element);
      if (performance.now() - sliceStart > SLICE_BUDGET_MS) {
        await yieldToMain();
        sliceStart = performance.now();
      }
    }
    if (truncated) break;
  }
  return { fields, elements, truncated };
}

/* ----------------------------- llenado ----------------------------- */

export type FillOutcome = "filled" | "skipped-has-value" | "skipped-detached" | "skipped-disabled" | "skipped-no-option";

/**
 * Escribe usando el setter del PROTOTYPE (HTMLInputElement/HTMLTextAreaElement/HTMLSelectElement).
 * React instala su propio `value` en la instancia para rastrear cambios; asignar `el.value = x`
 * actualiza ese rastreador y React ignora el evento posterior. El setter nativo lo esquiva.
 */
function setNativeValue(element: FillableElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
}

/**
 * Secuencia de eventos que cubre los frameworks habituales:
 *   input    → React onChange (texto), Angular DefaultValueAccessor, Vue v-model
 *   change   → selects en React/Angular/Vue, Formik, react-hook-form
 *   blur + focusout → validación al perder el foco (Angular updateOn:"blur"; React onBlur usa focusout)
 */
function dispatchFormEvents(element: FillableElement, value: string): void {
  const textual = !isSelect(element);
  element.dispatchEvent(
    textual
      ? new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value })
      : new Event("input", { bubbles: true, composed: true })
  );
  element.dispatchEvent(new Event("change", { bubbles: true }));
  element.dispatchEvent(new FocusEvent("blur"));
  element.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
}

/**
 * Rellena un elemento. Con `overwrite: false` jamás pisa lo que el usuario ya escribió
 * (se vuelve a comprobar aquí porque el valor pudo cambiar desde el escaneo).
 */
export function fillElement(element: FillableElement, value: string, options: { overwrite?: boolean } = {}): FillOutcome {
  if (!element.isConnected) return "skipped-detached";
  if (element.disabled || (!isSelect(element) && element.readOnly)) return "skipped-disabled";
  if (!options.overwrite && element.value.trim()) return "skipped-has-value";
  if (isSelect(element) && !Array.from(element.options).some(option => option.value === value)) return "skipped-no-option";
  setNativeValue(element, value);
  dispatchFormEvents(element, value);
  return "filled";
}

export interface FillReport {
  /** ids de los descriptores que se rellenaron. */
  readonly filled: ReadonlySet<string>;
  readonly skipped: number;
}

export function applyFieldMatches(matches: readonly FieldMatch[], elements: ReadonlyMap<string, FillableElement>): FillReport {
  const filled = new Set<string>();
  let skipped = 0;
  for (const match of matches) {
    const element = elements.get(match.fieldId);
    if (element && fillElement(element, match.value) === "filled") filled.add(match.fieldId);
    else skipped++;
  }
  return { filled, skipped };
}

export const MAGNETO_SELECTORS = [
  'input[name*="question"]',
  'textarea[name*="question"]',
  '.magneto-input input',
  '[data-testid*="form-field"] input'
];

// Función para asignar valor e informar al framework reactivo de Magneto
export function fillInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  )?.set;

  if (nativeSetter) {
    nativeSetter.call(input, value);
  } else {
    input.value = value;
  }

  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new Event('blur', { bubbles: true }));
}

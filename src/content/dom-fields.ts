/**
 * ÚNICO módulo que toca los elementos de formulario de la página:
 *   1. Escaneo: DOM → `FieldDescriptor[]` (datos planos que consume la lógica de negocio).
 *   2. Llenado: escribir un valor y simular los eventos que esperan React/Angular/Vue.
 *
 * La lógica de negocio (src/shared/*) nunca ve un Element.
 */
import type { FieldDescriptor, FieldKind, FieldMatch, FieldOption } from "../shared/types";
import { dateDigits } from "../shared/form-questions";
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
export function isRendered(element: Element): boolean {
  if (element.getAttribute("aria-hidden") === "true") return false;
  const check = (element as Element & { checkVisibility?: () => boolean }).checkVisibility;
  if (typeof check === "function") return check.call(element);
  // Sin motor de layout (p. ej. jsdom): un ancestro oculto por atributo o estilo cuenta como no visible.
  return !element.closest('[hidden], [style*="display: none"], [style*="display:none"]');
}

export function isUsable(element: FillableElement): boolean {
  if (element.disabled) return false;
  if (!isSelect(element) && element.readOnly) return false;
  return isRendered(element);
}

/**
 * Lector de etiquetas para campos sueltos (fuera de `scanFormFields`): indexa los `label[for]`
 * una sola vez por raíz (documento o Shadow DOM) y luego lee cada campo con las mismas reglas.
 */
export function makeLabelReader(): (element: FillableElement) => string {
  const contexts = new Map<Node, LabelContext>();
  return element => {
    const root = element.getRootNode() as Document | ShadowRoot;
    let context = contexts.get(root);
    if (!context) {
      context = buildLabelContext(root);
      contexts.set(root, context);
    }
    return readLabel(element, context);
  };
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
export interface ScanOptions {
  /** Elementos que el escáner genérico debe ignorar (p. ej. controles que ya maneja otro adaptador). */
  readonly exclude?: (element: Element) => boolean;
}

export async function scanFormFields(root: ParentNode = document, options: ScanOptions = {}): Promise<FormScan> {
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
      if (options.exclude?.(element)) continue;
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

/** ¿Es un campo de teléfono? (tipo tel, o el nombre/placeholder/etiqueta lo dice). */
export function looksLikePhone(element: FillableElement): boolean {
  if (element instanceof HTMLInputElement && element.type === "tel") return true;
  const hints = [element.getAttribute("placeholder"), element.getAttribute("aria-label"), element.getAttribute("name"), element.id]
    .join(" ")
    .normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return /telefono|celular|movil|phone|mobile|whatsapp/.test(hints);
}

/**
 * Teléfono: «+57 316 332 4904». Muchos formularios tienen el indicativo del país en otra casilla
 * y solo aceptan los dígitos nacionales («3163324904»); si la página rechaza el valor, la casilla
 * queda vacía. Se prueba primero lo más probable y se comprueba que el valor quedó escrito.
 */
export async function fillPhone(element: FillableElement, value: string): Promise<boolean> {
  const digits = value.replace(/\D/g, "");
  // Con indicativo («+57 316…», 12 dígitos), los formularios lo piden en su propia casilla y el
  // número va sin él: «3163324904». Solo si eso no queda escrito se prueba lo demás.
  const national = digits.length > 10 ? digits.slice(-10) : digits;
  const candidates = [...new Set([national, value, digits])].filter(Boolean);
  for (const [index, candidate] of candidates.entries()) {
    // Solo se reescribe lo que la extensión misma intentó y la página rechazó.
    if (index > 0 && element.value.replace(/\D/g, "").length >= 7) return true;
    if (fillElement(element, candidate, { overwrite: index > 0 }) !== "filled") return false;
    await new Promise(resolve => setTimeout(resolve, 60));
    if (element.value.replace(/\D/g, "").length >= 7) return true;
  }
  return false;
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

/* ------------------------- fechas en 8 casillas (Magneto) ------------------------- */

/**
 * Magneto escribe una fecha DD/MM/AAAA en ocho inputs de un solo carácter («Fecha de nacimiento»,
 * «Fecha y ciudad de nacimiento»…). No se agregan al escaneo genérico porque cada input, por
 * separado, no es una fecha: se tratan como un solo campo.
 */
const DIGIT_SELECTOR = 'input[maxlength="1"]';

export interface DigitDateGroup {
  readonly inputs: HTMLInputElement[];
  /** Texto normalizado que rodea al grupo, p. ej. «fecha y ciudad de nacimiento». */
  readonly context: string;
  readonly isBirthDate: boolean;
  readonly empty: boolean;
}

/** Casilla de un dígito de una fecha: teclado numérico, o marcador «D», «M», «A» o «Y». */
function isDigitBox(input: HTMLInputElement): boolean {
  const placeholder = (input.getAttribute("placeholder") ?? "").trim().toUpperCase();
  return input.getAttribute("inputmode") === "numeric" || /^[DMAY]$/.test(placeholder);
}

function digitBoxesIn(node: ParentNode): HTMLInputElement[] {
  return Array.from(node.querySelectorAll<HTMLInputElement>(DIGIT_SELECTOR)).filter(isDigitBox);
}

function normalizeDateLabel(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Todas las fechas de 8 casillas dentro de `scope` (y sus Shadow DOM abiertos). Solo lee. */
export function findDigitDateGroups(scope: ParentNode = document): DigitDateGroup[] {
  const roots: ParentNode[] = [scope];
  const visited = new Set<ParentNode>(roots);
  for (let index = 0; index < roots.length; index++) {
    for (const host of roots[index]!.querySelectorAll<Element>("*")) {
      const shadow = host.shadowRoot;
      if (shadow && !visited.has(shadow)) {
        visited.add(shadow);
        roots.push(shadow);
      }
    }
  }

  const seen = new Set<HTMLInputElement>();
  const groups: DigitDateGroup[] = [];
  for (const root of roots) {
    for (const first of digitBoxesIn(root)) {
      if (seen.has(first) || !isUsable(first)) continue;
      // El contenedor más pequeño con exactamente 8 casillas es el grupo.
      let wrapper: Element | null = first.parentElement;
      let inputs: HTMLInputElement[] | null = null;
      for (let depth = 0; wrapper && depth < 6; depth++, wrapper = wrapper.parentElement) {
        const inside = digitBoxesIn(wrapper);
        if (inside.length === 8) {
          inputs = inside;
          break;
        }
        if (inside.length > 8) break;
      }
      if (!inputs || !wrapper || inputs.some(input => !isUsable(input))) continue;
      for (const input of inputs) seen.add(input);

      // Texto alrededor (sin salir del bloque de esta fecha) para saber qué fecha es.
      let context = "";
      for (let node: Element | null = wrapper, depth = 0; node && depth < 6; depth++, node = node.parentElement) {
        if (digitBoxesIn(node).length !== 8) break;
        const text = normalizeDateLabel(node.textContent ?? "");
        if (/[a-z]/.test(text)) {
          context = text;
          if (text.includes("fecha")) break;
        }
      }
      groups.push({
        inputs,
        context,
        isBirthDate: context.includes("nacimiento"),
        empty: inputs.every(input => input.value.trim() === "")
      });
    }
  }
  return groups;
}

/** Grupo de 8 casillas VACÍAS de la fecha de nacimiento, o null (también si ya tiene algo escrito). Solo lee. */
export function findMagnetoBirthDateGroup(scope: ParentNode = document): HTMLInputElement[] | null {
  const group = findDigitDateGroups(scope).find(item => item.isBirthDate);
  return group?.empty ? group.inputs : null;
}

/** Escribe una fecha en sus 8 casillas. Acepta AAAA-MM-DD, DD/MM/AAAA o DDMMAAAA. */
export function fillDigitDate(rawValue: string, group: readonly HTMLInputElement[] | null): boolean {
  const digits = dateDigits(rawValue);
  if (!digits || !group || group.length !== 8) return false;
  // Se vuelve a comprobar: la página pudo cambiar entre la autorización y el llenado.
  if (group.some(input => !input.isConnected || !isUsable(input) || input.value.trim() !== "")) return false;

  for (let i = 0; i < group.length; i++) {
    const input = group[i]!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, digits[i]);
    else input.value = digits[i]!;
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true, composed: true, inputType: "insertText", data: digits[i]!
    }));
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }
  group[group.length - 1]!.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
  group[group.length - 1]!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  return true;
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

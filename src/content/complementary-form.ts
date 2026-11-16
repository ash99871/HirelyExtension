/**
 * Adaptador DOM del modal «Datos Complementarios» de Magneto.
 *
 * Maneja lo que el escáner genérico no entiende:
 *   - desplegables con lista (sector, nivel de estudios): se abren y se elige la opción;
 *   - sugerencias que aparecen al escribir (cargo);
 *   - monto de salario;
 *   - tarjetas o botones de elección (modalidad, jornada, disponibilidad).
 *
 * Solo rellena y marca. NUNCA pulsa «Siguiente» ni envía un formulario.
 */
import { fillElement, isRendered } from "./dom-fields";
import {
  APPROX_MIN_COVERAGE,
  MODAL_TITLE_PHRASE,
  optionCoverageScore,
  optionMatchScore,
  recognizeComplementaryField,
  type ComplementaryKey,
  type ComplementaryValues,
  type TextHint
} from "../shared/complementary-data";
import { normalizeText } from "../shared/text-similarity";

export type StepStatus =
  | "filled"
  | "selected"
  | "already-selected"
  | "already-filled"
  | "clicked-unverified"
  | "selected-approx"
  | "option-not-found"
  | "control-not-found"
  | "not-written";

export interface ComplementaryStep {
  readonly target: string;
  readonly status: StepStatus;
  /** Texto de la opción que se eligió, cuando fue por aproximación. */
  readonly detail?: string;
}

/** Resultado de una acción: un estado, con o sin detalle. */
interface Outcome {
  readonly status: StepStatus;
  readonly detail?: string;
}

export interface ComplementaryResult {
  /** Contenedor del modal, o null si la página no muestra «Datos Complementarios». */
  readonly modal: Element | null;
  readonly steps: readonly ComplementaryStep[];
}

export interface ComplementaryOptions {
  /** Pausa entre comprobaciones de una lista que aún se está dibujando. */
  readonly waitMs?: number;
}

const DEFAULT_WAIT_MS = 250;
const MAX_POLLS = 6;
const MAX_HINT_TEXT = 160;
const MAX_HINT_DEPTH = 4;
const MAX_OPTION_TEXT = 120;
const CONTROL_SELECTOR = "input, textarea, select";
const CLICKABLE = [
  '[role="option"]', '[role="menuitem"]', '[role="radio"]', '[role="checkbox"]', '[role="switch"]',
  '[role="button"]', "button", "label", "li", "a"
].join(", ");
// Magneto usa CSS modules: «…card--selected___SkzRf». Se reconoce la palabra aunque vaya unida con guiones o guiones bajos.
const SELECTED_CLASS = /(^|[\s_-])(selected|checked|active)([\s_-]|$)/i;
/** Desplegable personalizado de Magneto (select2): el botón visible que lo abre. */
const TRIGGER_SELECTOR = 'button[class*="select2-input_button"]';
const SELECTED_ATTRIBUTE = '[aria-pressed="true"], [aria-checked="true"], [aria-selected="true"]';
// «selected-approx» NO es OK: la opción se eligió por parecido y la persona debe confirmarla.
const OK_STATUSES: ReadonlySet<StepStatus> = new Set(["filled", "selected", "already-selected", "already-filled"]);

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const textOf = (el: Element): string => normalizeText(el.textContent ?? "");

/* ------------------------------ recorrido del DOM ------------------------------ */

/** La raíz dada y todos los Shadow DOM abiertos que contiene. */
function collectRoots(start: ParentNode): ParentNode[] {
  const roots: ParentNode[] = [];
  const visit = (node: ParentNode): void => {
    roots.push(node);
    for (const el of node.querySelectorAll<Element>("*")) {
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };
  visit(start);
  return roots;
}

function deepAll<T extends Element>(start: ParentNode, selector: string): T[] {
  return collectRoots(start).flatMap(root => [...root.querySelectorAll<T>(selector)]);
}

/** Padre en el árbol, cruzando el límite de un Shadow DOM hacia su host. */
function parentOf(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const host = (el.getRootNode() as ShadowRoot).host as Element | undefined;
  return host ?? null;
}

export function isInside(container: Element, el: Element): boolean {
  for (let node: Element | null = el; node; node = parentOf(node)) {
    if (node === container) return true;
  }
  return false;
}

/* ------------------------------ localizar el modal ------------------------------ */

export function findComplementaryModal(): Element | null {
  const titles = deepAll<Element>(document, "*")
    .filter(el => el.children.length <= 10 && isRendered(el) && textOf(el).includes(MODAL_TITLE_PHRASE))
    .sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length);

  // Subir desde el título hasta el primer contenedor que también tenga el botón «Siguiente».
  let node: Element | null = titles[0] ?? null;
  for (let depth = 0; node && depth < 12; depth++, node = parentOf(node)) {
    if (deepAll<Element>(node, "button, [role='button']").some(button => textOf(button).includes("siguiente"))) {
      return node;
    }
  }
  return null;
}

/* ------------------------------ reconocer controles ------------------------------ */

/**
 * Controles de la página. Primero los botones de los desplegables de Magneto: su <input> oculto
 * también aparece en el DOM, pero no se puede abrir, así que el botón debe ganar siempre.
 */
function modalControls(modal: Element): HTMLElement[] {
  const triggers = deepAll<HTMLElement>(modal, TRIGGER_SELECTOR)
    .filter(el => isRendered(el) && !el.hasAttribute("disabled"));
  const inputs = deepAll<HTMLElement>(modal, CONTROL_SELECTOR).filter(el => {
    const type = (el as HTMLInputElement).type ?? "";
    return isRendered(el) && !el.hasAttribute("disabled") && !["hidden", "checkbox", "radio", "file", "button", "submit"].includes(type);
  });
  return [...triggers, ...inputs];
}

/** Texto del bloque que contiene SOLO este control (p. ej. su celda en una fila de tres). */
function ownBlockText(control: HTMLElement): string {
  let block: Element = control;
  for (let node = parentOf(control); node && deepAll<Element>(node, CONTROL_SELECTOR).length <= 1; node = parentOf(node)) {
    block = node;
  }
  const text = textOf(block);
  return text.length <= MAX_HINT_TEXT ? text : "";
}

/** <input> oculto del mismo desplegable: lleva el nombre real del campo y su etiqueta. */
function companionInput(trigger: Element): HTMLInputElement | null {
  let node: Element | null = trigger.parentElement;
  for (let depth = 0; node && depth < 2; depth++, node = node.parentElement) {
    const input = node.querySelector("input");
    if (input) return input as HTMLInputElement;
  }
  return null;
}

function hintsFor(control: HTMLElement): TextHint[] {
  const hints: TextHint[] = [];
  const add = (raw: string | null | undefined, depth: number): void => {
    const text = normalizeText(raw ?? "");
    if (text) hints.push({ text, depth });
  };
  const addAttributes = (el: Element): void => {
    add(el.getAttribute("placeholder"), 0);
    add(el.getAttribute("aria-label"), 0);
    add(el.getAttribute("name"), 0);
    add(el.id, 0);
    for (const label of Array.from((el as HTMLInputElement).labels ?? [])) add(label.textContent, 0);
  };

  addAttributes(control);
  if (control.matches(TRIGGER_SELECTOR)) {
    const companion = companionInput(control);
    if (companion) addAttributes(companion);
  }

  let node: Element | null = parentOf(control);
  for (let depth = 1; node && depth <= MAX_HINT_DEPTH; depth++, node = parentOf(node)) {
    const text = textOf(node);
    if (text && text.length <= MAX_HINT_TEXT) hints.push({ text, depth });
  }
  return hints;
}

function locateControls(modal: Element): Map<ComplementaryKey, HTMLElement> {
  const found = new Map<ComplementaryKey, HTMLElement>();
  for (const control of modalControls(modal)) {
    const key = recognizeComplementaryField(hintsFor(control), ownBlockText(control));
    if (key && !found.has(key)) found.set(key, control);
  }
  return found;
}

/* ------------------------------ acciones ------------------------------ */

/** Dispara la secuencia completa de eventos que espera un framework; bloquea el envío de formularios. */
function clickEl(el: Element): void {
  (el as HTMLElement).scrollIntoView?.({ block: "center" });
  // Un botón dentro de un <form> enviaría el formulario al pulsarlo: se cancela ese envío.
  const root = el.getRootNode() as unknown as EventTarget;
  const blockSubmit = (event: Event): void => event.preventDefault();
  root.addEventListener("submit", blockSubmit, true);
  try {
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true, cancelable: true }));
    }
  } finally {
    root.removeEventListener("submit", blockSubmit, true);
  }
}

/** Escribe como lo haría el usuario: con el setter nativo y un evento input (sin blur, para no cerrar la lista). */
function typeText(input: HTMLInputElement, text: string): void {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

interface OptionSearch {
  readonly modal: Element;
  /** true: solo opciones dentro del modal (chips). false: también listas que se abren fuera (portales). */
  readonly anywhere: boolean;
  /** Elementos que ya existían antes de abrir la lista: fuera del modal, solo cuentan los nuevos. */
  readonly before?: ReadonlySet<Element>;
}

/** Elemento clicable con el texto de la opción. Prefiere coincidencia exacta y luego el elemento más pequeño. */
function findOption(wanted: string, search: OptionSearch): HTMLElement | null {
  let best: { el: Element; score: number; size: number } | null = null;
  const pool = search.anywhere ? deepAll<Element>(document, "*") : deepAll<Element>(search.modal, "*");
  for (const el of pool) {
    const inModal = isInside(search.modal, el);
    if (!inModal && search.before?.has(el)) continue;
    if (!isRendered(el)) continue;
    const text = el.textContent ?? "";
    if (text.length > MAX_OPTION_TEXT) continue;
    const score = optionMatchScore(text, wanted);
    if (!score) continue;
    const size = el.querySelectorAll("*").length;
    if (!best || score > best.score || (score === best.score && size < best.size)) best = { el, score, size };
  }
  if (!best) return null;
  return (best.el.closest(CLICKABLE) as HTMLElement | null) ?? (best.el as HTMLElement);
}

/** Espera a que aparezca la opción: revisa primero y luego cada `waitMs`. */
async function waitForOption(wanted: string, search: OptionSearch, waitMs: number): Promise<HTMLElement | null> {
  for (let poll = 0; poll < MAX_POLLS; poll++) {
    const found = findOption(wanted, search);
    if (found) return found;
    await sleep(waitMs);
  }
  return null;
}

/**
 * Opción de una lista ya abierta que mejor coincide con el texto libre, si lo hace de forma clara.
 * Solo mira elementos nuevos (la lista que acaba de abrirse), no el resto de la página.
 */
function findApproxOption(wanted: string, search: OptionSearch): HTMLElement | null {
  let best: { el: Element; coverage: number; length: number } | null = null;
  for (const el of deepAll<Element>(document, "*")) {
    const inModal = isInside(search.modal, el);
    if (!inModal && search.before?.has(el)) continue;
    if (!el.matches('[role="option"], li') || !isRendered(el)) continue;
    const text = el.textContent ?? "";
    if (!text || text.length > MAX_OPTION_TEXT) continue;
    const coverage = optionCoverageScore(text, wanted);
    if (coverage < APPROX_MIN_COVERAGE) continue;
    if (!best || coverage > best.coverage || (coverage === best.coverage && text.length < best.length)) {
      best = { el, coverage, length: text.length };
    }
  }
  if (!best) return null;
  return (best.el.closest(CLICKABLE) as HTMLElement | null) ?? (best.el as HTMLElement);
}

/** Valor visible del control: el value de un <input>, o el texto de un botón de desplegable. */
function currentText(control: HTMLElement): string {
  if (control.tagName === "INPUT" || control.tagName === "TEXTAREA") return (control as HTMLInputElement).value ?? "";
  return textOf(control);
}

/** Resultado de elegir una opción: exacta si el texto coincide completo; si no, para revisar. */
function outcomeFor(option: HTMLElement, wanted: string): Outcome {
  const text = (option.textContent ?? "").replace(/\s+/g, " ").trim();
  return normalizeText(text) === normalizeText(wanted)
    ? { status: "selected" }
    : { status: "selected-approx", detail: text };
}

/**
 * Tras abrir una lista o escribir en un buscador: elige la opción exacta y, si no existe, la más
 * parecida (marcada para revisar). La misma regla vale para listas cerradas (Sector, Nivel de
 * estudios) y para buscadores de texto libre (Cargo): Magneto puede no tener el texto exacto de
 * Hirely en ningún caso, así que todos los campos que abren una lista usan esta única función.
 */
async function resolveOpenOption(wanted: string, search: OptionSearch, waitMs: number): Promise<Outcome> {
  const exact = await waitForOption(wanted, search, waitMs);
  if (exact) {
    clickEl(exact);
    return outcomeFor(exact, wanted);
  }
  const approx = findApproxOption(wanted, search);
  if (approx) {
    clickEl(approx);
    return outcomeFor(approx, wanted);
  }
  return { status: "option-not-found" };
}

async function pickFromCombobox(control: HTMLElement, wanted: string, modal: Element, waitMs: number): Promise<Outcome> {
  if (normalizeText(currentText(control)).includes(normalizeText(wanted))) return { status: "already-filled" };
  const before = new Set(deepAll<Element>(document, "*"));
  control.focus?.();
  clickEl(control);
  return resolveOpenOption(wanted, { modal, anywhere: true, before }, waitMs);
}

/**
 * Desplegable con buscador (botón + campo de texto que aparece al abrir):
 * se abre, se escribe el texto y se elige la sugerencia.
 */
async function pickSearchableTrigger(trigger: HTMLElement, wanted: string, modal: Element, waitMs: number): Promise<Outcome> {
  if (normalizeText(currentText(trigger)).includes(normalizeText(wanted))) return { status: "already-filled" };
  const before = new Set(deepAll<Element>(document, "*"));
  clickEl(trigger);

  let search: HTMLInputElement | null = null;
  for (let poll = 0; poll < MAX_POLLS && !search; poll++) {
    search = findSearchInput(trigger, before);
    if (!search) await sleep(waitMs);
  }
  if (!search) return { status: "option-not-found", detail: "no encontré dónde escribir" };

  search.focus();
  typeText(search, wanted);
  return resolveOpenOption(wanted, { modal, anywhere: true, before }, waitMs);
}

/** Campo de texto visible que abrió el desplegable: primero dentro de él, luego uno nuevo en la página. */
function findSearchInput(trigger: Element, before: ReadonlySet<Element>): HTMLInputElement | null {
  const container = trigger.parentElement;
  const visible = deepAll<HTMLInputElement>(document, "input").filter(input =>
    isRendered(input) && !input.disabled && !input.readOnly && ["", "text", "search"].includes(input.type));
  const local = container ? visible.find(input => isInside(container, input)) : undefined;
  return local ?? visible.find(input => !before.has(input)) ?? null;
}

async function pickSuggestion(control: HTMLElement, wanted: string, modal: Element, waitMs: number): Promise<Outcome> {
  if (control.tagName !== "INPUT") return pickSearchableTrigger(control, wanted, modal, waitMs);
  const input = control as HTMLInputElement;
  if (input.value.trim()) return { status: "already-filled" };
  const before = new Set(deepAll<Element>(document, "*"));
  input.focus();
  typeText(input, wanted);
  return resolveOpenOption(wanted, { modal, anywhere: true, before }, waitMs);
}

function fillSalary(control: HTMLElement, amount: string): StepStatus {
  const input = control as HTMLInputElement;
  const current = input.value.replace(/\D/g, "");
  // «0» es el valor por defecto de Magneto: se trata como vacío. Cualquier otro número se respeta.
  if (current && current !== "0") return "already-filled";
  return fillElement(input, amount, { overwrite: true }) === "filled" ? "filled" : "not-written";
}

/** Marca una tarjeta o botón de elección dentro del modal. */
function isSelected(el: Element): boolean {
  if (el.querySelector('input[type="checkbox"]:checked, input[type="radio"]:checked')) return true;
  let node: Element | null = el;
  for (let depth = 0; node && depth < 3; depth++, node = parentOf(node)) {
    if (node.matches(SELECTED_ATTRIBUTE)) return true;
    if (SELECTED_CLASS.test(node.getAttribute("class") ?? "")) return true;
  }
  return false;
}

async function pickChoice(wanted: string, modal: Element, waitMs: number): Promise<StepStatus> {
  const target = findOption(wanted, { modal, anywhere: false });
  if (!target) return "option-not-found";
  if (isSelected(target)) return "already-selected";
  clickEl(target);
  await sleep(waitMs);
  const after = findOption(wanted, { modal, anywhere: false }) ?? target;
  return isSelected(after) ? "selected" : "clicked-unverified";
}

/* ------------------------------ plan (solo lectura) ------------------------------ */

export type ComplementaryPlanKey = ComplementaryKey | "preference";

/** Algo que se PODRÍA llenar en el modal. Se muestra a la persona para que lo autorice. */
export interface ComplementaryPlanItem {
  readonly key: ComplementaryPlanKey;
  /** Nombre del campo para el panel («Sector», «Salario», «Opción»…). */
  readonly target: string;
  /** Valor que se escribiría o elegiría. Para una opción, su texto («Remoto»). */
  readonly value: string;
}

export interface ComplementaryPlan {
  readonly modal: Element | null;
  readonly items: readonly ComplementaryPlanItem[];
}

const PLAN_TARGETS: Readonly<Record<ComplementaryKey, string>> = {
  sector: "Sector",
  job_title: "Cargo",
  education_level: "Nivel de estudios",
  salary: "Salario"
};

const PLAN_VALUES: Readonly<Record<ComplementaryKey, (values: ComplementaryValues) => string>> = {
  sector: values => values.sector,
  job_title: values => values.jobTitle,
  education_level: values => values.educationLevel,
  salary: values => values.salary
};

/** ¿El control ya tiene ese valor (o, en el salario, cualquier monto distinto de 0)? */
function controlAlreadyHas(key: ComplementaryKey, control: HTMLElement, value: string): boolean {
  const text = currentText(control);
  if (key === "salary") {
    const digits = text.replace(/\D/g, "");
    return digits !== "" && digits !== "0";
  }
  return normalizeText(text).includes(normalizeText(value)) && normalizeText(value) !== "";
}

/**
 * Qué se llenaría en el modal, SIN tocar nada: no abre listas, no escribe, no hace clic.
 * Omite lo que no tiene valor en el perfil, lo que no tiene control en la página y lo que ya está puesto.
 */
export function planComplementaryModal(values: ComplementaryValues): ComplementaryPlan {
  const modal = findComplementaryModal();
  if (!modal) return { modal: null, items: [] };

  const controls = locateControls(modal);
  const items: ComplementaryPlanItem[] = [];
  for (const key of Object.keys(PLAN_TARGETS) as ComplementaryKey[]) {
    const value = PLAN_VALUES[key](values);
    const control = controls.get(key);
    if (!value || !control || controlAlreadyHas(key, control, value)) continue;
    items.push({ key, target: PLAN_TARGETS[key], value });
  }
  for (const preference of values.workPreferences) {
    const option = findOption(preference, { modal, anywhere: false });
    if (!option || isSelected(option)) continue;
    items.push({ key: "preference", target: "Opción", value: preference });
  }
  return { modal, items };
}

/**
 * Valores para `fillComplementaryModal` con SOLO lo que la persona autorizó (y como lo editó).
 * Lo que no aparece en `approved` queda vacío y, por tanto, no se toca.
 */
export function authorizedComplementaryValues(approved: readonly ComplementaryPlanItem[]): ComplementaryValues {
  const pick = (key: ComplementaryKey): string => approved.find(item => item.key === key)?.value.trim() ?? "";
  return {
    sector: pick("sector"),
    jobTitle: pick("job_title"),
    educationLevel: pick("education_level"),
    salary: pick("salary").replace(/\D/g, ""),
    workPreferences: approved.filter(item => item.key === "preference").map(item => item.value)
  };
}

/* ------------------------------ punto de entrada ------------------------------ */

async function runStep(
  steps: ComplementaryStep[],
  target: string,
  control: HTMLElement | undefined,
  action: (el: HTMLElement) => StepStatus | Outcome | Promise<StepStatus | Outcome>
): Promise<void> {
  if (!control) {
    steps.push({ target, status: "control-not-found" });
    return;
  }
  const result = await action(control);
  if (typeof result === "string") {
    steps.push({ target, status: result });
  } else if (result.detail === undefined) {
    steps.push({ target, status: result.status });
  } else {
    steps.push({ target, status: result.status, detail: result.detail });
  }
}

/**
 * Rellena el modal de datos complementarios si está visible. Si no está, no hace nada.
 * Cada paso informa de su resultado para mostrarlo en el panel.
 */
export async function fillComplementaryModal(values: ComplementaryValues, options: ComplementaryOptions = {}): Promise<ComplementaryResult> {
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const modal = findComplementaryModal();
  if (!modal) return { modal: null, steps: [] };

  const controls = locateControls(modal);
  const steps: ComplementaryStep[] = [];

  if (values.sector) {
    await runStep(steps, "Sector", controls.get("sector"), el => pickFromCombobox(el, values.sector, modal, waitMs));
  }
  if (values.jobTitle) {
    await runStep(steps, "Cargo", controls.get("job_title"), el => pickSuggestion(el, values.jobTitle, modal, waitMs));
  }
  if (values.educationLevel) {
    await runStep(steps, "Nivel de estudios", controls.get("education_level"), el => pickFromCombobox(el, values.educationLevel, modal, waitMs));
  }
  if (values.salary) {
    await runStep(steps, "Salario", controls.get("salary"), el => fillSalary(el, values.salary));
  }
  for (const preference of values.workPreferences) {
    steps.push({ target: `Opción: ${preference}`, status: await pickChoice(preference, modal, waitMs) });
  }
  return { modal, steps };
}

/** Frase corta para el panel: cuántos pasos quedaron listos y cuáles revisar. */
export function summarizeComplementary(result: ComplementaryResult): string {
  if (!result.modal) return "";
  if (!result.steps.length) return " Datos complementarios detectados, sin valores en tu perfil. Discapacidad: responde tú.";
  const done = result.steps.filter(step => OK_STATUSES.has(step.status)).length;
  const pending = result.steps
    .filter(step => !OK_STATUSES.has(step.status))
    .map(step => step.detail ? `${step.target} (elegí «${step.detail.slice(0, 60)}»)` : step.target);
  const review = pending.length ? ` Revisar: ${pending.join(", ")}.` : "";
  return ` Datos complementarios: ${done} de ${result.steps.length} listos.${review} Discapacidad: responde tú.`;
}

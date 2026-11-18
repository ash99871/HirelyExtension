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
  CLICKABLE,
  MAX_OPTION_TEXT,
  TRIGGER_SELECTOR,
  chosenChips,
  clickEl,
  closeStrayLists,
  companionInput,
  deepAll,
  findSearchInput,
  isInside,
  isSelected,
  parentOf,
  sleep,
  textOf,
  typeText
} from "./dom-actions";
import {
  APPROX_MIN_COVERAGE,
  MODAL_SUBMIT_WORDS,
  MODAL_TITLE_PHRASES,
  cityOptionScore,
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
  /** Control de cada paso (por su nombre, «Sector»…): para volver a preguntarlo si no se pudo llenar. */
  readonly controls?: ReadonlyMap<string, Element>;
}

export interface ComplementaryOptions {
  /** Pausa entre comprobaciones de una lista que aún se está dibujando. */
  readonly waitMs?: number;
}

const DEFAULT_WAIT_MS = 250;
/** Espera máxima por las sugerencias de ciudad (~5 s con 250 ms), que llegan de internet. */
const CITY_POLLS = 20;
const MAX_POLLS = 6;
const MAX_HINT_TEXT = 160;
const MAX_HINT_DEPTH = 4;
const CONTROL_SELECTOR = "input, textarea, select";
// «selected-approx» NO es OK: la opción se eligió por parecido y la persona debe confirmarla.
const OK_STATUSES: ReadonlySet<StepStatus> = new Set(["filled", "selected", "already-selected", "already-filled"]);

export { isInside };

/* ------------------------------ localizar el modal ------------------------------ */

export function findComplementaryModal(): Element | null {
  const titles = deepAll<Element>(document, "*")
    .filter(el => {
      if (el.children.length > 10 || !isRendered(el)) return false;
      const text = textOf(el);
      return MODAL_TITLE_PHRASES.some(phrase => text.includes(phrase));
    })
    .sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length);

  // Subir desde el título hasta el primer contenedor que también tenga el botón «Siguiente» o «Guardar».
  let node: Element | null = titles[0] ?? null;
  for (let depth = 0; node && depth < 12; depth++, node = parentOf(node)) {
    const buttons = deepAll<Element>(node, "button, [role='button']");
    if (buttons.some(button => MODAL_SUBMIT_WORDS.some(word => textOf(button).includes(word)))) {
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
    // Con una lista recién abierta (`before`), solo cuenta lo que apareció al abrirla: nunca otros
    // textos de la ventana (p. ej. el título del paso «Datos Complementarios» al buscar «Datos»).
    if (search.before?.has(el)) continue;
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
    if (search.before?.has(el)) continue;
    if (!el.matches('[role="option"], li, button[class*="list__item"]') || !isRendered(el)) continue;
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
  // Listas de varias opciones (Sector): lo elegido está en las etiquetas «×» de debajo, no en el botón.
  return [textOf(control), ...chosenChips(control).map(normalizeText)].join(" ");
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

async function pickSuggestion(control: HTMLElement, wanted: string, modal: Element, waitMs: number): Promise<Outcome> {
  if (control.tagName !== "INPUT") return pickSearchableTrigger(control, wanted, modal, waitMs);
  const input = control as HTMLInputElement;
  if (input.value.trim()) return { status: "already-filled" };
  const before = new Set(deepAll<Element>(document, "*"));
  input.focus();
  typeText(input, wanted);
  return resolveOpenOption(wanted, { modal, anywhere: true, before }, waitMs);
}

/**
 * «¿Dónde quieres trabajar?»: se abre el desplegable, se escribe la ciudad y se elige la sugerencia
 * de la ciudad del perfil EN el país del perfil. Magneto pone primero ciudades homónimas de otros
 * países («Medellín, Veracruz…, México» antes de «Medellín, Antioquia, Colombia»).
 */
async function pickCity(control: HTMLElement, city: string, country: string, waitMs: number): Promise<Outcome> {
  if (normalizeText(currentText(control)).startsWith(normalizeText(city))) return { status: "already-filled" };
  const before = new Set(deepAll<Element>(document, "*"));
  let search: HTMLInputElement | null = control.tagName === "INPUT" ? control as HTMLInputElement : null;
  if (!search) {
    clickEl(control);
    for (let poll = 0; poll < MAX_POLLS && !search; poll++) {
      search = findSearchInput(control, before);
      if (!search) await sleep(waitMs);
    }
  }
  if (!search) return { status: "option-not-found", detail: "no encontré dónde escribir" };

  search.focus();
  typeText(search, city);
  // La lista de ciudades se busca en internet: la primera vez puede tardar varios segundos.
  for (let poll = 0; poll < CITY_POLLS; poll++) {
    await sleep(waitMs);
    // Si a mitad de la espera no ha llegado nada, se vuelve a escribir (por si la búsqueda no arrancó).
    if (poll === Math.floor(CITY_POLLS / 2)) {
      typeText(search, "");
      typeText(search, city);
    }
    let best: { el: Element; score: number } | null = null;
    for (const el of deepAll<Element>(document, CLICKABLE)) {
      if (before.has(el) || !isRendered(el)) continue;
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!text || text.length > MAX_OPTION_TEXT) continue;
      const score = cityOptionScore(text, city, country);
      if (score && (!best || score > best.score)) best = { el, score };
    }
    // Con el país del perfil, solo vale una ciudad de ese país: se sigue esperando (las de otros
    // países suelen llegar primero) y, si no aparece, no se elige nada y se le pregunta a la persona.
    if (best && country && best.score < 4) best = null;
    if (best) {
      clickEl(best.el);
      const text = (best.el.textContent ?? "").replace(/\s+/g, " ").trim();
      // Siempre se informa cuál se eligió (hay ciudades con el mismo nombre en otros países). Con el país
      // del perfil en la sugerencia, la ciudad es la correcta; sin país (o sin coincidir), se pide revisar.
      return best.score >= 4
        ? { status: "selected", detail: text }
        : { status: "selected-approx", detail: text };
    }
  }
  return { status: "option-not-found" };
}

function fillSalary(control: HTMLElement, amount: string): StepStatus {
  const input = control as HTMLInputElement;
  const current = input.value.replace(/\D/g, "");
  // «0» es el valor por defecto de Magneto: se trata como vacío. Cualquier otro número se respeta.
  if (current && current !== "0") return "already-filled";
  return fillElement(input, amount, { overwrite: true }) === "filled" ? "filled" : "not-written";
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
  /**
   * Controles que este adaptador va a llenar (los de `items`). Las preguntas del panel los
   * ignoran para no preguntar dos veces lo mismo.
   */
  readonly handled: readonly Element[];
}

const PLAN_TARGETS: Readonly<Record<ComplementaryKey, string>> = {
  sector: "Sector",
  job_title: "Cargo",
  education_level: "Nivel de estudios",
  salary: "Salario",
  city: "Ciudad"
};

const PLAN_VALUES: Readonly<Record<ComplementaryKey, (values: ComplementaryValues) => string>> = {
  sector: values => values.sector,
  job_title: values => values.jobTitle,
  education_level: values => values.educationLevel,
  salary: values => values.salary,
  city: values => values.city
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
  if (!modal) return { modal: null, items: [], handled: [] };

  const controls = locateControls(modal);
  const items: ComplementaryPlanItem[] = [];
  const handled: Element[] = [];
  for (const key of Object.keys(PLAN_TARGETS) as ComplementaryKey[]) {
    const value = PLAN_VALUES[key](values);
    const control = controls.get(key);
    if (!value || !control || controlAlreadyHas(key, control, value)) continue;
    items.push({ key, target: PLAN_TARGETS[key], value });
    handled.push(control);
  }
  for (const preference of values.workPreferences) {
    const option = findOption(preference, { modal, anywhere: false });
    if (!option || isSelected(option)) continue;
    items.push({ key: "preference", target: "Opción", value: preference });
    handled.push(option);
  }
  return { modal, items, handled };
}

/**
 * Valores para `fillComplementaryModal` con SOLO lo que la persona autorizó (y como lo editó).
 * Lo que no aparece en `approved` queda vacío y, por tanto, no se toca. `base` aporta el país del
 * perfil, que no se muestra en la lista pero sirve para elegir la ciudad correcta.
 */
export function authorizedComplementaryValues(approved: readonly ComplementaryPlanItem[], base?: ComplementaryValues): ComplementaryValues {
  const pick = (key: ComplementaryKey): string => approved.find(item => item.key === key)?.value.trim() ?? "";
  return {
    sector: pick("sector"),
    jobTitle: pick("job_title"),
    educationLevel: pick("education_level"),
    salary: pick("salary").replace(/\D/g, ""),
    workPreferences: approved.filter(item => item.key === "preference").map(item => item.value),
    city: pick("city"),
    country: base?.country ?? ""
  };
}

/* ------------------------------ punto de entrada ------------------------------ */

async function runStep(
  steps: ComplementaryStep[],
  target: string,
  control: HTMLElement | undefined,
  action: (el: HTMLElement) => StepStatus | Outcome | Promise<StepStatus | Outcome>,
  used?: Map<string, Element>
): Promise<void> {
  if (!control) {
    steps.push({ target, status: "control-not-found" });
    return;
  }
  used?.set(target, control);
  // Una lista que quedó abierta (p. ej. la de Sector, que admite varias) se tragaría el clic del siguiente campo.
  await closeStrayLists(DEFAULT_WAIT_MS);
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
  const used = new Map<string, Element>();

  if (values.sector) {
    await runStep(steps, "Sector", controls.get("sector"), el => pickFromCombobox(el, values.sector, modal, waitMs), used);
  }
  if (values.jobTitle) {
    await runStep(steps, "Cargo", controls.get("job_title"), el => pickSuggestion(el, values.jobTitle, modal, waitMs), used);
  }
  if (values.educationLevel) {
    await runStep(steps, "Nivel de estudios", controls.get("education_level"), el => pickFromCombobox(el, values.educationLevel, modal, waitMs), used);
  }
  if (values.salary) {
    await runStep(steps, "Salario", controls.get("salary"), el => fillSalary(el, values.salary), used);
  }
  if (values.city) {
    await runStep(steps, "Ciudad", controls.get("city"), el => pickCity(el, values.city, values.country, waitMs), used);
  }
  for (const preference of values.workPreferences) {
    steps.push({ target: `Opción: ${preference}`, status: await pickChoice(preference, modal, waitMs) });
  }
  // Al terminar no debe quedar ninguna lista abierta (la de Sector admite varias y queda abierta).
  await closeStrayLists(waitMs);
  return { modal, steps, controls: used };
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

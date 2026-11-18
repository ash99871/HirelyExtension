/**
 * Preguntas de la página: TODO campo vacío del formulario abierto se convierte en una pregunta
 * para el panel, aunque Hirely no tenga ese dato en el perfil.
 *
 *   1. `findFormScope`: qué formulario está abierto (la ventana/modal de encima, o la página).
 *   2. `collectQuestions`: reconoce cada control y su pregunta — texto, fechas, listas <select>,
 *      radios, casillas, botones de opción y los desplegables propios de Magneto (cuyas opciones
 *      se leen abriéndolos y cerrándolos sin elegir nada).
 *   3. `applyAnswer`: escribe o elige la respuesta como lo haría la persona.
 *   4. `isHandleFilled` / `countPendingFields`: qué sigue vacío (revisión final y aviso
 *      «Formulario detectado»).
 *
 * NUNCA pulsa «Guardar», «Siguiente» ni «Enviar», ni toca contraseñas o archivos.
 */
import {
  fillDigitDate,
  fillElement,
  fillPhone,
  looksLikePhone,
  findDigitDateGroups,
  isRendered,
  isUsable,
  makeLabelReader,
  type FillableElement
} from "./dom-fields";
import {
  TRIGGER_SELECTOR,
  chosenChips,
  clickEl,
  closeOpenList,
  closeStrayLists,
  companionInput,
  deepAll,
  findSearchInput,
  isAnyListOpen,
  isInside,
  isSelected,
  newVisibleOptions,
  sleep,
  squash,
  typeText
} from "./dom-actions";
import {
  cleanQuestionLabel,
  isSensitiveQuestion,
  isoDate,
  labelSaysOptional,
  labelSaysRequired,
  looksMultiChoice,
  type PageQuestion,
  type QuestionAnswer,
  type QuestionKind,
  type QuestionOption
} from "../shared/form-questions";
import { optionCoverageScore, optionMatchScore } from "../shared/complementary-data";
import { detectOpenQuestions } from "../shared/question-detection";
import { normalizeText } from "../shared/text-similarity";

/* ------------------------------ configuración ------------------------------ */

const DEFAULT_WAIT_MS = 120;
const PROBE_POLLS = 5;
const CHOOSE_POLLS = 8;
const MAX_LABEL_TEXT = 160;
const MAX_QUESTIONS = 80;

/** Ventanas/modales: Magneto no usa role="dialog", sino `div.mg_modal_magneto-ui-modal`. */
const MODAL_SELECTOR = [
  '[role="dialog"]', '[aria-modal="true"]', "dialog[open]", '[class*="magneto-ui-modal"]',
  '[class*="ant-modal-wrap"]', '[class*="MuiDialog-root"]', ".modal.show", ".modal.in",
  // El sitio público de Magneto (crear cuenta, postulación) usa otras ventanas: cualquier clase con «modal».
  '[class*="modal"]', '[class*="Modal"]'
].join(", ");

/** Zonas que no son el formulario: buscador del encabezado, menús, pie de página. */
const OUTSIDE_FORM = 'header, nav, footer, [role="search"], [role="banner"], [role="navigation"], [role="contentinfo"]';
const SEARCH_HINT = /\b(buscar|busca|busqueda|search|palabra clave)\b/;

/**
 * Botones de opción de Magneto (estado civil, disponibilidad): `mg_toggle_button_magneto-ui-toggle-button`.
 * OJO: los títulos de «Nivel 1…4» del perfil son `levelLayout-module__toggle-button` y NO son opciones.
 */
const TOGGLE_SELECTOR = 'button[class*="magneto-ui-toggle-button"]';
/** Tarjetas de opción: modalidad de trabajo, «Sexo registrado en tu documento»… (botón con título y descripción). */
const CARD_SELECTOR = 'button[class*="card"], button[class*="Card"], [role="button"][class*="card"], [role="button"][class*="Card"]';
const ARIA_RADIO = '[role="radio"]:not(input)';

/** Cualquier control de formulario (para saber dónde empieza «otra pregunta»). */
const CONTROL_SELECTOR = [
  "input:not([type=hidden])", "textarea", "select", TRIGGER_SELECTOR, TOGGLE_SELECTOR, CARD_SELECTOR,
  '[role="radio"]', '[role="checkbox"]', '[role="combobox"]'
].join(", ");

const TEXT_TYPES: ReadonlySet<string> = new Set(["", "text", "email", "tel", "number", "url", "date"]);
const SKIPPED_TYPES: ReadonlySet<string> = new Set([
  "hidden", "password", "submit", "button", "image", "reset", "range", "color", "search",
  "datetime-local", "month", "week", "time"
]);

/* ------------------------------ tipos ------------------------------ */

/** Cómo volver al control real de una pregunta. Vive solo mientras dura la ejecución del asistente. */
export type QuestionHandle =
  | { readonly kind: "field"; readonly element: HTMLInputElement | HTMLTextAreaElement }
  | { readonly kind: "select"; readonly element: HTMLSelectElement; readonly values: ReadonlyMap<string, string> }
  | { readonly kind: "options"; readonly elements: ReadonlyMap<string, HTMLElement> }
  | { readonly kind: "checkbox"; readonly element: HTMLElement }
  | { readonly kind: "dropdown"; readonly trigger: HTMLElement; readonly placeholder: string; readonly labels: ReadonlyMap<string, string> }
  | { readonly kind: "digits"; readonly inputs: readonly HTMLInputElement[] };

export interface ScannedQuestion {
  readonly question: PageQuestion;
  readonly handle: QuestionHandle;
  /** Elemento de referencia (orden en la página, identidad entre revisiones). */
  readonly anchor: Element;
}

export interface PageScan {
  readonly scope: ParentNode;
  readonly items: readonly ScannedQuestion[];
  /** Archivos que la persona debe adjuntar ella misma (la extensión no sube archivos). */
  readonly files: readonly string[];
}

export interface ProbeResult {
  readonly options: readonly string[];
  readonly searchable: boolean;
}

export interface CollectOptions {
  /** Controles que ya llena otro adaptador (perfil, modal de Magneto): no se preguntan. */
  readonly isHandled?: (element: Element) => boolean;
  /** Leer las opciones de los desplegables abriéndolos (por defecto, sí). */
  readonly probe?: boolean;
  /** Opciones ya leídas, por nombre de lista: las listas con el mismo nombre se abren una sola vez. */
  readonly probeCache?: Map<string, ProbeResult>;
  readonly waitMs?: number;
  readonly onProgress?: (message: string) => void;
}

/* ------------------------------ formulario abierto ------------------------------ */

function hasVisibleControls(container: ParentNode): boolean {
  return deepAll<Element>(container, CONTROL_SELECTOR).some(isRendered);
}

/**
 * El formulario que la persona tiene delante: la ventana/modal de más arriba que tenga campos;
 * si no hay ninguna, la página completa (sin encabezado, menús ni pie de página).
 */
export function findFormScope(): ParentNode {
  const candidates = deepAll<HTMLElement>(document, MODAL_SELECTOR).filter(el =>
    el !== document.body && el !== document.documentElement && isRendered(el) && hasVisibleControls(el));
  const outermost = candidates.filter(el => !candidates.some(other => other !== el && isInside(other, el)));
  return outermost[outermost.length - 1] ?? document;
}

function outsideForm(element: Element, scope: ParentNode): boolean {
  return scope === document && element.closest(OUTSIDE_FORM) !== null;
}

function looksLikeSearch(element: Element): boolean {
  const hints = [element.getAttribute("placeholder"), element.getAttribute("aria-label"), element.getAttribute("name"), element.id]
    .map(value => normalizeText(value ?? ""))
    .join(" ");
  return SEARCH_HINT.test(hints);
}

/** Campos que no son del formulario: encabezado, menús, pie de página y buscadores (solo en la página completa). */
export function isFormNoise(element: Element, scope: ParentNode): boolean {
  return outsideForm(element, scope) || (scope === document && looksLikeSearch(element));
}

/* ------------------------------ textos de las preguntas ------------------------------ */

/**
 * Texto de un elemento con un espacio entre cada trozo: dos párrafos seguidos dan
 * «Control · App 30/09/2026», no «Control · App30/09/2026» (como pasaría con textContent).
 */
function spacedText(el: Element): string {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) parts.push(node.nodeValue ?? "");
  return squash(parts.join(" "));
}

function shortText(el: Element): string {
  const text = spacedText(el);
  return text.length <= MAX_LABEL_TEXT && /[\p{L}\p{N}]/u.test(text) ? text : "";
}

const DATE_RANGE = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/;

/** Primer texto «hoja» (sin elementos dentro) de un bloque que no sea una fecha: el título del bloque. */
function firstLeafText(el: Element, skip: string): string {
  const candidates = [el, ...Array.from(el.querySelectorAll("*"))];
  for (const node of candidates) {
    if (node.children.length || !isRendered(node)) continue;
    const text = shortText(node);
    if (text && normalizeText(text) !== skip && !DATE_RANGE.test(text)) return text;
  }
  return "";
}

/** «Selecciona un género», «Agrega un cargo…»: instrucciones, no el nombre del campo. */
const INSTRUCTION = /^(selecciona|seleccione|elige|escoge|agrega|anade|escribe|ingresa|digita|busca|indica)\b/;

/**
 * Texto de la pregunta que va ANTES del control: el hermano anterior más cercano con texto corto,
 * subiendo hasta 6 niveles. Si en el camino aparece otro campo visible, se detiene: ese texto
 * sería la pregunta de otro campo.
 */
function questionTextBefore(target: Element, scope: ParentNode): string {
  let node: Element | null = target;
  for (let depth = 0; node && depth < 6 && node !== scope; depth++, node = node.parentElement) {
    for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
      if (!isRendered(sibling)) continue;
      const controls = deepAll<Element>(sibling, CONTROL_SELECTOR).filter(isRendered);
      if (controls.length || sibling.matches(CONTROL_SELECTOR)) return "";
      const text = shortText(sibling);
      if (text) return text;
    }
  }
  return "";
}

/** Para preguntas repetidas («Cargo equivalente» en cada experiencia): el título del bloque que las contiene. */
function contextFor(anchor: Element, label: string, scope: ParentNode): string {
  const own = normalizeText(label);
  let node: Element | null = anchor.parentElement;
  for (let depth = 0; node && depth < 8 && node !== scope; depth++, node = node.parentElement) {
    for (const child of Array.from(node.children)) {
      if (isInside(child, anchor)) break;
      if (!isRendered(child) || deepAll<Element>(child, CONTROL_SELECTOR).some(isRendered)) continue;
      // Se saltan la propia pregunta y los rangos de fechas («30/09/2026 - 15/11/2026»).
      const text = firstLeafText(child, own);
      if (text) return text;
    }
  }
  return "";
}

/**
 * Texto de una opción: su <label> (por `for` o envolvente), su aria-label, o el texto que la
 * acompaña. No se usa el texto del contenedor: incluiría las demás opciones («Sí No»).
 */
function optionLabel(control: Element): string {
  if (control instanceof HTMLInputElement) {
    const fromLabels = Array.from(control.labels ?? []).map(label => squash(label.textContent)).find(Boolean);
    if (fromLabels) return fromLabels.slice(0, 80);
    const aria = squash(control.getAttribute("aria-label"));
    if (aria) return aria;
    for (const next of [control.nextElementSibling, control.parentElement?.nextElementSibling]) {
      const text = next ? squash(next.textContent) : "";
      if (text) return text.slice(0, 80);
    }
    return control.value === "on" ? "Sí" : control.value;
  }
  // Tarjetas: título + descripción («Hombre · Sexo registrado como masculino…»). Solo el título.
  const heading = control.querySelector("h1, h2, h3, h4, h5, h6, strong, b");
  if (heading) return squash(heading.textContent).slice(0, 80);
  return (firstLeafText(control, "") || squash(control.textContent)).slice(0, 80);
}

/* ------------------------------ borradores ------------------------------ */

interface Draft {
  readonly anchor: Element;
  readonly rawLabel: string;
  readonly fallbackLabel: string;
  readonly kind: QuestionKind;
  readonly options: readonly QuestionOption[];
  readonly searchable: boolean;
  readonly inputType: string;
  readonly requiredAttr: boolean;
  readonly handle: QuestionHandle;
  /** Desplegable cuyas opciones aún hay que leer. */
  readonly trigger?: HTMLElement;
  readonly listName?: string;
}

const optionList = (labels: readonly string[]): QuestionOption[] => labels.map((label, index) => ({ id: `o${index + 1}`, label }));

function isRequiredControl(el: Element): boolean {
  return el.hasAttribute("required") || el.getAttribute("aria-required") === "true";
}

/** Radio sin `name` (p. ej. Ant Design): su grupo es el contenedor más cercano que reúne varios radios. */
function radioContainer(radio: HTMLInputElement): Element | null {
  let node: Element | null = radio.parentElement;
  for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
    if (node.querySelectorAll('input[type="radio"]').length > 1) return node;
  }
  return radio;
}

/** Grupo de botones de opción: el contenedor más cercano que reúne varios del mismo tipo. */
function groupContainer(el: Element, selector: string): Element | null {
  let node: Element | null = el.parentElement;
  for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
    if (node.querySelectorAll(selector).length > 1) return node;
  }
  return el.parentElement;
}

/** Contenedor común más pequeño de varios elementos. */
function commonAncestor(elements: readonly Element[]): Element {
  let node: Element | null = elements[0]!.parentElement;
  while (node && !elements.every(el => isInside(node!, el))) node = node.parentElement;
  return node ?? elements[0]!;
}

function groupBy<T>(items: readonly T[], key: (item: T) => unknown): T[][] {
  const groups = new Map<unknown, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = groups.get(k);
    if (list) list.push(item);
    else groups.set(k, [item]);
  }
  return [...groups.values()];
}

/** ¿El botón del desplegable de Magneto muestra solo su nombre (vacío) o nombre + valor elegido? */
function dropdownPlaceholder(trigger: HTMLElement): string {
  const companion = companionInput(trigger);
  return squash(companion?.getAttribute("name") || companion?.getAttribute("placeholder") || trigger.textContent);
}

function dropdownIsEmpty(trigger: HTMLElement, placeholder: string): boolean {
  // Lista de varias opciones: lo elegido aparece como etiquetas debajo y el botón no cambia.
  if (chosenChips(trigger).length) return false;
  const text = normalizeText(trigger.textContent ?? "");
  return !text || text === normalizeText(placeholder);
}

function findDrafts(scope: ParentNode, isHandled: (el: Element) => boolean, files: string[]): Draft[] {
  const readLabel = makeLabelReader();
  const drafts: Draft[] = [];
  const skip = (el: Element): boolean => isHandled(el) || outsideForm(el, scope);

  // 1. Fechas de 8 casillas (Magneto). Sus casillas no cuentan como campos sueltos.
  const digitInputs = new Set<Element>();
  for (const group of findDigitDateGroups(scope)) {
    for (const input of group.inputs) digitInputs.add(input);
    if (!group.empty || group.inputs.some(skip)) continue;
    const first = group.inputs[0]!;
    drafts.push({
      anchor: first,
      rawLabel: questionTextBefore(commonAncestor(group.inputs), scope),
      fallbackLabel: group.isBirthDate ? "Fecha de nacimiento" : "Fecha",
      kind: "date", options: [], searchable: false, inputType: "date",
      requiredAttr: group.inputs.some(isRequiredControl),
      handle: { kind: "digits", inputs: group.inputs }
    });
  }

  // 2. Campos nativos: texto, fechas, áreas de texto y listas <select>.
  for (const el of deepAll<FillableElement>(scope, "input, textarea, select")) {
    if (digitInputs.has(el) || skip(el)) continue;
    const type = el instanceof HTMLInputElement ? el.type.toLowerCase() : "";
    if (type === "file") {
      if (!(el as HTMLInputElement).files?.length && !outsideForm(el, scope)) {
        files.push(cleanQuestionLabel(readLabel(el) || questionTextBefore(el, scope)) || "Archivo");
      }
      continue;
    }
    if (type === "checkbox" || type === "radio" || SKIPPED_TYPES.has(type)) continue;
    if (!isUsable(el) || (scope === document && looksLikeSearch(el))) continue;

    if (el instanceof HTMLSelectElement) {
      const real = Array.from(el.options).filter(option => option.value !== "" && !option.disabled);
      const selected = el.selectedOptions[0];
      if (!real.length || (selected && selected.value !== "")) continue;
      const options = optionList(real.map(option => squash(option.label || option.text)));
      drafts.push({
        anchor: el, rawLabel: readLabel(el) || questionTextBefore(el, scope), fallbackLabel: "Elige una opción",
        kind: "choice", options, searchable: false, inputType: "", requiredAttr: isRequiredControl(el),
        handle: { kind: "select", element: el, values: new Map(options.map((option, i) => [option.id, real[i]!.value])) }
      });
      continue;
    }

    if (!TEXT_TYPES.has(type) && el instanceof HTMLInputElement) continue;
    if (el.value.trim()) continue;
    const label = readLabel(el) || questionTextBefore(el, scope);
    // Buscadores de la página («Buscar por cargo o profesión»): no son parte del formulario.
    if (scope === document && SEARCH_HINT.test(normalizeText(label))) continue;
    // Buscador tipo «combobox» (React-Select y similares): se escribe y se elige la sugerencia.
    if (el.getAttribute("role") === "combobox") {
      drafts.push({
        anchor: el, rawLabel: label, fallbackLabel: "Escribe y elige", kind: "text", options: [], searchable: true,
        inputType: "text", requiredAttr: isRequiredControl(el),
        handle: { kind: "dropdown", trigger: el, placeholder: "", labels: new Map() }
      });
      continue;
    }
    const open = el instanceof HTMLTextAreaElement || detectOpenQuestions([{
      id: "", kind: "input", inputType: type, label, hints: "", value: "", options: [],
      maxLength: el.maxLength, size: (el as HTMLInputElement).size ?? 0
    }]).length > 0;
    drafts.push({
      anchor: el, rawLabel: label, fallbackLabel: "Campo sin nombre",
      kind: type === "date" ? "date" : open ? "long-text" : "text",
      options: [], searchable: false, inputType: type, requiredAttr: isRequiredControl(el),
      handle: { kind: "field", element: el as HTMLInputElement | HTMLTextAreaElement }
    });
  }

  // 3. Radios nativos (por nombre o, sin nombre, por el contenedor que reúne varios) y casillas.
  const radios = deepAll<HTMLInputElement>(scope, 'input[type="radio"]').filter(el => !skip(el) && !el.disabled);
  for (const group of groupBy(radios, el => el.name ? `name:${el.name}` : radioContainer(el))) {
    if (group.some(el => el.checked) || !group.some(isRendered)) continue;
    const container = group.length > 1 ? commonAncestor(group) : group[0]!;
    const legend = container.closest("fieldset")?.querySelector("legend");
    const options = optionList(group.map(optionLabel));
    drafts.push({
      anchor: group[0]!, rawLabel: (legend ? squash(legend.textContent) : "") || questionTextBefore(container, scope),
      fallbackLabel: "Elige una opción", kind: "choice", options, searchable: false, inputType: "",
      requiredAttr: group.some(isRequiredControl),
      handle: { kind: "options", elements: new Map(options.map((option, i) => [option.id, group[i]!])) }
    });
  }

  const checkboxes = deepAll<HTMLInputElement>(scope, 'input[type="checkbox"]').filter(el => !skip(el) && !el.disabled && isRendered(el));
  for (const group of groupBy(checkboxes, el => el.name ? `name:${el.name}` : el)) {
    if (group.some(el => el.checked)) continue;
    if (group.length === 1) {
      const el = group[0]!;
      drafts.push({
        anchor: el, rawLabel: readLabel(el) || questionTextBefore(el, scope), fallbackLabel: "Casilla",
        kind: "checkbox", options: [], searchable: false, inputType: "", requiredAttr: isRequiredControl(el),
        handle: { kind: "checkbox", element: el }
      });
      continue;
    }
    const container = commonAncestor(group);
    const options = optionList(group.map(optionLabel));
    drafts.push({
      anchor: group[0]!, rawLabel: questionTextBefore(container, scope), fallbackLabel: "Marca las que apliquen",
      kind: "multi", options, searchable: false, inputType: "", requiredAttr: group.some(isRequiredControl),
      handle: { kind: "options", elements: new Map(options.map((option, i) => [option.id, group[i]!])) }
    });
  }

  // 4. Botones de opción: ARIA (role="radio"), botones de Magneto (estado civil, disponibilidad) y tarjetas (modalidad).
  const buttonGroups: { members: HTMLElement[]; multi: boolean | null; fallback: string }[] = [];
  const ariaRadios = deepAll<HTMLElement>(scope, ARIA_RADIO).filter(el => !skip(el) && isRendered(el));
  for (const group of groupBy(ariaRadios, el => el.closest('[role="radiogroup"]') ?? el.parentElement)) {
    buttonGroups.push({ members: group, multi: false, fallback: "Elige una opción" });
  }
  const seenButtons = new Set<Element>();
  for (const selector of [TOGGLE_SELECTOR, CARD_SELECTOR]) {
    const buttons = deepAll<HTMLElement>(scope, selector)
      .filter(el => isRendered(el) && !outsideForm(el, scope) && !seenButtons.has(el) && !el.querySelector(selector))
      // Sin ventana abierta, solo cuentan dentro de un <form> (no tarjetas de ofertas ni secciones del perfil).
      .filter(el => scope !== document || el.closest("form") !== null)
      // Botones que abren o cierran una sección (acordeón) no son opciones.
      .filter(el => !el.hasAttribute("aria-expanded"));
    for (const el of buttons) seenButtons.add(el);
    // Cada tarjeta puede ir en su propia envoltura: el grupo es el contenedor que reúne varias.
    for (const group of groupBy(buttons, el => groupContainer(el, selector))) {
      // Una pregunta de opciones tiene al menos dos. Si otro adaptador marca alguna, ya está cubierta.
      if (group.length < 2 || group.some(isHandled)) continue;
      const modality = group.some(el => /modality/i.test(el.getAttribute("class") ?? ""));
      buttonGroups.push({
        members: group,
        multi: modality ? true : null,
        fallback: modality ? "Modalidad de trabajo" : "Elige una opción"
      });
    }
  }
  for (const { members, multi, fallback } of buttonGroups) {
    if (members.some(isSelected)) continue;
    const container = members.length > 1 ? commonAncestor(members) : members[0]!;
    const aria = container.getAttribute("aria-label") ?? "";
    const rawLabel = aria || questionTextBefore(container, scope);
    const options = optionList(members.map(optionLabel));
    const isMulti = multi ?? looksMultiChoice(rawLabel);
    drafts.push({
      anchor: members[0]!, rawLabel, fallbackLabel: fallback, kind: isMulti ? "multi" : "choice",
      options, searchable: false, inputType: "", requiredAttr: false,
      handle: { kind: "options", elements: new Map(options.map((option, i) => [option.id, members[i]!])) }
    });
  }

  // 5. Desplegables propios de Magneto (select2): el botón muestra solo su nombre mientras está vacío.
  for (const trigger of deepAll<HTMLElement>(scope, TRIGGER_SELECTOR)) {
    if (skip(trigger) || !isRendered(trigger) || trigger.hasAttribute("disabled")) continue;
    const placeholder = dropdownPlaceholder(trigger);
    if (!dropdownIsEmpty(trigger, placeholder)) continue;
    const companion = companionInput(trigger);
    // El nombre real del campo («Cargo equivalente») gana; si es una instrucción
    // («Selecciona un género»), se usa la pregunta visible («¿Con cuál género te identificas?»).
    const named = placeholder && !INSTRUCTION.test(normalizeText(placeholder));
    const before = questionTextBefore(trigger, scope);
    // (Si el texto visible es el mismo nombre, se usa ese: conserva marcas como «*» u «(opcional)»).
    const sameAsName = normalizeText(cleanQuestionLabel(before)) === normalizeText(placeholder);
    const rawLabel = named && !sameAsName ? placeholder : before;
    drafts.push({
      anchor: trigger,
      rawLabel,
      fallbackLabel: placeholder || "Elige una opción",
      kind: "choice", options: [], searchable: false, inputType: "",
      requiredAttr: isRequiredControl(trigger) || (companion !== null && isRequiredControl(companion)),
      handle: { kind: "dropdown", trigger, placeholder, labels: new Map() },
      trigger, listName: normalizeText(placeholder)
    });
  }

  drafts.sort((a, b) => (a.anchor.compareDocumentPosition(b.anchor) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  return drafts.slice(0, MAX_QUESTIONS);
}

/* ------------------------------ leer opciones de un desplegable ------------------------------ */

/** Cierra la lista que se abrió (después de `before`) y comprueba que quedó cerrada. */
function closeDropdown(before: ReadonlySet<Element>, near: Element, waitMs: number): Promise<boolean> {
  return closeOpenList(() => newVisibleOptions(before).length > 0 || isAnyListOpen(), near, waitMs);
}

/**
 * Abre el desplegable, lee sus opciones y lo cierra haciendo clic fuera, SIN elegir nada.
 * Si no muestra opciones pero sí un buscador (p. ej. «Cargo», «Ciudad»), es una lista con buscador.
 */
export async function probeDropdown(trigger: HTMLElement, waitMs = DEFAULT_WAIT_MS): Promise<ProbeResult & { closed: boolean }> {
  if (!(await closeStrayLists(waitMs))) return { options: [], searchable: true, closed: false };
  const before = new Set(deepAll<Element>(document, "*"));
  clickEl(trigger, { scroll: false });
  let found: HTMLElement[] = [];
  let search: HTMLInputElement | null = null;
  for (let poll = 0; poll < PROBE_POLLS; poll++) {
    await sleep(waitMs);
    found = newVisibleOptions(before);
    search ??= findSearchInput(trigger, before);
    if (found.length) {
      await sleep(waitMs); // que termine de dibujarse la lista
      found = newVisibleOptions(before);
      break;
    }
  }
  const options = found.map(el => squash(el.textContent));
  const closed = await closeDropdown(before, trigger, waitMs);
  return { options, searchable: !options.length && search !== null, closed };
}

/* ------------------------------ recolectar ------------------------------ */

/**
 * Todas las preguntas del formulario abierto, en el orden de la página. Lo que ya tiene valor,
 * lo que llena otro adaptador y lo que está fuera del formulario no se pregunta.
 */
export async function collectQuestions(scope: ParentNode, options: CollectOptions = {}): Promise<PageScan> {
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const cache = options.probeCache ?? new Map<string, ProbeResult>();
  const files: string[] = [];
  const drafts = findDrafts(scope, options.isHandled ?? (() => false), files);

  // Leer las opciones de los desplegables (una sola vez por nombre de lista).
  const toProbe = options.probe === false ? [] : drafts.filter(draft => draft.trigger && !cache.has(draft.listName ?? ""));
  let done = 0;
  for (const draft of toProbe) {
    const key = draft.listName ?? "";
    if (cache.has(key)) continue;
    options.onProgress?.(`Leyendo las opciones de las listas (${++done} de ${toProbe.length})…`);
    if (!draft.trigger!.isConnected) continue;
    const { closed, ...result } = await probeDropdown(draft.trigger!, waitMs);
    if (key) cache.set(key, result);
    // Si una lista no se deja cerrar, no se abre ninguna más: las demás se responden escribiendo.
    if (!closed) break;
  }

  const built = drafts.map(draft => {
    let { kind, options: opts, searchable, handle } = draft;
    if (draft.trigger) {
      const probe = cache.get(draft.listName ?? "") ?? { options: [], searchable: true };
      opts = optionList(probe.options);
      searchable = probe.searchable || !opts.length;
      kind = opts.length ? "choice" : "text";
      if (handle.kind === "dropdown") handle = { ...handle, labels: new Map(opts.map(option => [option.id, option.label])) };
    }
    const label = cleanQuestionLabel(draft.rawLabel) || cleanQuestionLabel(draft.fallbackLabel);
    return { draft, label, kind, opts, searchable, handle };
  });

  // Preguntas repetidas («Cargo equivalente» × 3): se les agrega el bloque al que pertenecen.
  const counts = new Map<string, number>();
  for (const item of built) counts.set(normalizeText(item.label), (counts.get(normalizeText(item.label)) ?? 0) + 1);

  const items: ScannedQuestion[] = built.map((item, index) => {
    const repeated = (counts.get(normalizeText(item.label)) ?? 0) > 1;
    const context = repeated ? contextFor(item.draft.anchor, item.label, scope) : "";
    const label = context ? `${item.label} · ${context}` : item.label;
    const question: PageQuestion = {
      id: `q${index + 1}`,
      kind: item.kind,
      label,
      required: item.draft.requiredAttr || labelSaysRequired(item.draft.rawLabel),
      optional: labelSaysOptional(item.draft.rawLabel),
      sensitive: isSensitiveQuestion(`${item.label} ${item.draft.fallbackLabel}`),
      options: item.opts,
      searchable: item.searchable,
      inputType: item.draft.inputType
    };
    return { question, handle: item.handle, anchor: item.draft.anchor };
  });
  return { scope, items, files: [...new Set(files)] };
}

/** Cuántos campos vacíos tiene el formulario (sin abrir listas): para el aviso «Formulario detectado». */
export function countPendingFields(scope: ParentNode, options: { formsOnly?: boolean } = {}): number {
  const drafts = findDrafts(scope, () => false, []);
  if (!options.formsOnly) return drafts.length;
  return drafts.filter(draft => draft.anchor.closest("form") !== null).length;
}

/* ------------------------------ responder ------------------------------ */

/** Opción de una lista abierta que mejor corresponde al texto: exacta, por prefijo o por palabras en común. */
function bestOptionElement(options: readonly HTMLElement[], wanted: string): HTMLElement | null {
  let best: { el: HTMLElement; score: number } | null = null;
  for (const el of options) {
    const text = squash(el.textContent);
    const match = optionMatchScore(text, wanted);
    const coverage = optionCoverageScore(text, wanted);
    const score = match === 2 ? 3 : match === 1 ? 2 : coverage >= 0.6 ? 1 + coverage / 2 : 0;
    if (score && (!best || score > best.score)) best = { el, score };
  }
  return best?.el ?? null;
}

/**
 * Elige `wanted` en un desplegable: lo abre, busca la opción y, si no está a la vista y hay
 * buscador, escribe el texto y elige la sugerencia. Si no la encuentra, lo cierra sin elegir.
 */
export async function chooseInDropdown(trigger: HTMLElement, wanted: string, waitMs = DEFAULT_WAIT_MS): Promise<boolean> {
  // Una lista abierta (de la página o de antes) se tragaría el clic: primero se cierra.
  await closeStrayLists(waitMs);
  const before = new Set(deepAll<Element>(document, "*"));
  // En el buscador se escribe solo el nombre («Sabaneta»), pero se elige con todo lo que dio la
  // persona («Sabaneta, Antioquia» → la de Antioquia, no la de México).
  const query = wanted.split(",")[0]!.trim() || wanted;
  let typed = false;
  if (trigger instanceof HTMLInputElement) {
    trigger.focus();
    typeText(trigger, query);
    typed = true;
  } else {
    clickEl(trigger);
  }
  let candidate: HTMLElement | null = null;
  for (let poll = 0; poll < CHOOSE_POLLS; poll++) {
    await sleep(waitMs);
    const options = newVisibleOptions(before);
    candidate = bestOptionElement(options, wanted);
    // Exacta o con todas las palabras: se elige ya. Si no, se espera un poco por si la lista
    // (que llega de internet) trae una mejor; al final se elige la mejor que haya.
    const complete = candidate !== null && (optionMatchScore(squash(candidate.textContent), wanted) === 2 || optionCoverageScore(squash(candidate.textContent), wanted) === 1);
    if (candidate && (complete || poll >= CHOOSE_POLLS - 3)) break;
    if (!typed && (options.length === 0 || poll >= 1)) {
      const search = findSearchInput(trigger, before);
      if (search) {
        search.focus();
        typeText(search, query);
        typed = true;
      }
    }
  }
  if (candidate?.isConnected) {
    clickEl(candidate, { scroll: false });
    await sleep(waitMs);
    // En las listas de varias opciones la lista sigue abierta tras elegir: se cierra para no
    // bloquear el siguiente campo.
    if (newVisibleOptions(before).length || isAnyListOpen()) await closeDropdown(before, trigger, waitMs);
    return true;
  }
  await closeDropdown(before, trigger, waitMs);
  return false;
}

function clickOption(el: HTMLElement): void {
  if (el instanceof HTMLInputElement) el.click();
  else clickEl(el);
}

/** Escribe o elige la respuesta en la página. Devuelve si el campo quedó con valor. */
export async function applyAnswer(handle: QuestionHandle, answer: QuestionAnswer, waitMs = DEFAULT_WAIT_MS): Promise<boolean> {
  switch (handle.kind) {
    case "field": {
      let text = answer.text?.trim() ?? "";
      if (!text) return false;
      if (handle.element instanceof HTMLInputElement && handle.element.type === "date") {
        const iso = isoDate(text);
        if (!iso) return false;
        text = iso;
      }
      if (looksLikePhone(handle.element)) return fillPhone(handle.element, text);
      return fillElement(handle.element, text) === "filled";
    }
    case "select": {
      const value = handle.values.get(answer.optionIds?.[0] ?? "");
      return value !== undefined && fillElement(handle.element, value) === "filled";
    }
    case "options": {
      const ids = answer.optionIds ?? [];
      if (!ids.length) return false;
      for (const id of ids) {
        const el = handle.elements.get(id);
        if (!el?.isConnected) return false;
        if (!isSelected(el)) {
          clickOption(el);
          await sleep(Math.min(waitMs, 60));
        }
      }
      return ids.every(id => isSelected(handle.elements.get(id)!));
    }
    case "checkbox": {
      if (!answer.checked) return false;
      if (!isSelected(handle.element)) clickOption(handle.element);
      return isSelected(handle.element);
    }
    case "dropdown": {
      const wanted = answer.optionIds?.length ? handle.labels.get(answer.optionIds[0]!) ?? "" : answer.text?.trim() ?? "";
      if (!wanted || !handle.trigger.isConnected) return false;
      return chooseInDropdown(handle.trigger, wanted, waitMs);
    }
    case "digits":
      return fillDigitDate(answer.text ?? "", handle.inputs);
  }
}

/** ¿El campo ya tiene valor? (revisión final). */
export function isHandleFilled(handle: QuestionHandle): boolean {
  switch (handle.kind) {
    case "field":
    case "select":
      return handle.element.value.trim() !== "";
    case "options":
      return [...handle.elements.values()].some(isSelected);
    case "checkbox":
      return isSelected(handle.element);
    case "dropdown":
      return handle.trigger instanceof HTMLInputElement
        ? handle.trigger.value.trim() !== ""
        : !dropdownIsEmpty(handle.trigger, handle.placeholder);
    case "digits":
      return handle.inputs.every(input => input.value.trim() !== "");
  }
}

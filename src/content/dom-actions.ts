/**
 * Acciones de bajo nivel sobre la página, compartidas por los adaptadores de formularios
 * (modal de datos complementarios de Magneto y preguntas del panel).
 *
 * Imitan lo que haría la persona: clic con la secuencia completa de eventos, escribir con el
 * setter nativo, cerrar una lista haciendo clic fuera. NUNCA envían un formulario.
 */
import { isRendered } from "./dom-fields";
import { normalizeText } from "../shared/text-similarity";

export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
export const textOf = (el: Element): string => normalizeText(el.textContent ?? "");
/** Texto visible de un elemento, con los espacios normalizados (sin quitar acentos). */
export const squash = (text: string | null | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();

export const MAX_OPTION_TEXT = 120;

/** Elementos en los que se puede hacer clic para elegir una opción. */
export const CLICKABLE = [
  '[role="option"]', '[role="menuitem"]', '[role="radio"]', '[role="checkbox"]', '[role="switch"]',
  '[role="button"]', "button", "label", "li", "a"
].join(", ");

/** Desplegable personalizado de Magneto (select2): el botón visible que lo abre. */
export const TRIGGER_SELECTOR = 'button[class*="select2-input_button"]';

/** Opciones de una lista abierta: Magneto (botones `select2-list__item`), ARIA (role=option) y listas comunes. */
export const OPTION_SELECTOR = '[role="option"], [role="menuitem"], [class*="list__item"], button[class*="select2-list"], li';

// Magneto usa CSS modules: «…card--selected___SkzRf», «…toggle-button-selected_1g06c». Se reconoce la
// palabra aunque vaya unida con guiones o guiones bajos.
const SELECTED_CLASS = /(^|[\s_-])(selected|checked|active)([\s_-]|$)/i;
const SELECTED_ATTRIBUTE = '[aria-pressed="true"], [aria-checked="true"], [aria-selected="true"]';

/* ------------------------------ recorrido del DOM ------------------------------ */

/** La raíz dada y todos los Shadow DOM abiertos que contiene. */
export function collectRoots(start: ParentNode): ParentNode[] {
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

export function deepAll<T extends Element>(start: ParentNode, selector: string): T[] {
  return collectRoots(start).flatMap(root => [...root.querySelectorAll<T>(selector)]);
}

/** Padre en el árbol, cruzando el límite de un Shadow DOM hacia su host. */
export function parentOf(el: Element): Element | null {
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

/** <input> oculto de un desplegable de Magneto: lleva el nombre real del campo («Selecciona un género»). */
export function companionInput(trigger: Element): HTMLInputElement | null {
  let node: Element | null = trigger.parentElement;
  for (let depth = 0; node && depth < 2; depth++, node = node.parentElement) {
    const input = node.querySelector("input");
    if (input) return input as HTMLInputElement;
  }
  return null;
}

/* ------------------------------ acciones ------------------------------ */

/** Dispara la secuencia completa de eventos que espera un framework; bloquea el envío de formularios. */
export function clickEl(el: Element, options: { scroll?: boolean } = {}): void {
  if (options.scroll !== false) (el as HTMLElement).scrollIntoView?.({ block: "center" });
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

/** Cierra una lista desplegable abierta haciendo clic en el fondo de la página, como la persona. */
export function clickOutside(): void {
  const body = document.body;
  if (!body) return;
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    body.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true, cancelable: true }));
  }
}

/* ------------------------------ listas abiertas ------------------------------ */

/** Opciones de las listas de Magneto (select2) que están a la vista: si hay alguna, hay una lista abierta. */
const MAGNETO_OPTION = 'button[class*="select2-list"]';

/** Botón de lista de Magneto escondido mientras su buscador está a la vista = esa lista está abierta. */
function openTriggers(): HTMLElement[] {
  return deepAll<HTMLElement>(document, TRIGGER_SELECTOR).filter(trigger => {
    if (!trigger.isConnected || isRendered(trigger)) return false;
    const companion = companionInput(trigger);
    return companion !== null && isRendered(companion);
  });
}

export function isAnyListOpen(): boolean {
  return deepAll<Element>(document, MAGNETO_OPTION).some(isRendered) || openTriggers().length > 0;
}

function pressEscape(): void {
  const target = document.activeElement ?? document.body;
  for (const type of ["keydown", "keyup"]) {
    target?.dispatchEvent(new KeyboardEvent(type, { key: "Escape", code: "Escape", bubbles: true, composed: true }));
  }
}

/**
 * Cierra una lista abierta y COMPRUEBA que se cerró. Prueba, en orden, lo que haría la persona:
 * clic en el fondo de la página, clic dentro de la ventana (fuera de la lista), Escape y volver
 * a pulsar el botón de la lista. Nunca hace clic en una opción. Devuelve si quedó cerrada.
 */
export async function closeOpenList(isOpen: () => boolean, near: Element | null, waitMs: number): Promise<boolean> {
  const container = near?.closest('[class*="magneto-ui-modal"], [role="dialog"], form') ?? null;
  const attempts: (() => void)[] = [
    () => clickOutside(),
    () => { if (container) clickEl(container, { scroll: false }); },
    () => pressEscape(),
    () => { for (const trigger of openTriggers()) clickEl(trigger, { scroll: false }); }
  ];
  for (const attempt of attempts) {
    if (!isOpen()) break;
    attempt();
    await sleep(waitMs);
  }
  (document.activeElement as HTMLElement | null)?.blur?.();
  return !isOpen();
}

/** Antes de abrir una lista: si quedó alguna abierta (de la página o de antes), se cierra. */
export async function closeStrayLists(waitMs: number): Promise<boolean> {
  if (!isAnyListOpen()) return true;
  return closeOpenList(isAnyListOpen, openTriggers()[0] ?? deepAll<Element>(document, MAGNETO_OPTION).find(isRendered) ?? null, waitMs);
}

/**
 * Lo ya elegido en una lista de VARIAS opciones de Magneto («Sector o sectores laborales»): cada
 * elección aparece como una etiqueta con «×» debajo del botón, que sigue mostrando su nombre.
 */
export function chosenChips(trigger: Element): string[] {
  // El bloque del campo: el contenedor más grande que solo tiene ESTA lista.
  let field: Element = trigger;
  for (let node = trigger.parentElement, depth = 0; node && depth < 5; depth++, node = node.parentElement) {
    if (node.querySelectorAll(TRIGGER_SELECTOR).length > 1 || node.querySelector("form, [class*='magneto-ui-modal']")) break;
    field = node;
  }
  const own = trigger.parentElement;
  const chips: string[] = [];
  for (const el of Array.from(field.querySelectorAll<HTMLElement>("*"))) {
    if (el.children.length > 3 || !isRendered(el) || (own && own.contains(el)) || el.contains(trigger)) continue;
    const text = squash(el.textContent);
    const removable = /[×✕✖]\s*$/.test(text) || el.querySelector(":scope > button, :scope > svg") !== null;
    const label = text.replace(/[×✕✖]\s*$/, "").trim();
    if (removable && label && label.length <= 80 && !chips.includes(label)) chips.push(label);
  }
  return chips;
}

/** Escribe como lo haría el usuario: con el setter nativo y un evento input (sin blur, para no cerrar la lista). */
export function typeText(input: HTMLInputElement, text: string): void {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

/** ¿Está marcada esta opción (tarjeta, botón, casilla)? */
export function isSelected(el: Element): boolean {
  if (el.matches('input[type="checkbox"], input[type="radio"]')) return (el as HTMLInputElement).checked;
  if (el.querySelector('input[type="checkbox"]:checked, input[type="radio"]:checked')) return true;
  let node: Element | null = el;
  for (let depth = 0; node && depth < 3; depth++, node = parentOf(node)) {
    if (node.matches(SELECTED_ATTRIBUTE)) return true;
    if (SELECTED_CLASS.test(node.getAttribute("class") ?? "")) return true;
  }
  return false;
}

/** Campo de texto visible que abrió el desplegable: primero dentro de él, luego uno nuevo en la página. */
export function findSearchInput(trigger: Element, before: ReadonlySet<Element>): HTMLInputElement | null {
  const container = trigger.parentElement;
  const visible = deepAll<HTMLInputElement>(document, "input").filter(input =>
    isRendered(input) && !input.disabled && !input.readOnly && ["", "text", "search"].includes(input.type));
  const local = container ? visible.find(input => isInside(container, input)) : undefined;
  return local ?? visible.find(input => !before.has(input)) ?? null;
}

/** Opciones que aparecieron después de `before` (la lista que se acaba de abrir), sin duplicados. */
export function newVisibleOptions(before: ReadonlySet<Element>): HTMLElement[] {
  const seen = new Set<string>();
  const found: HTMLElement[] = [];
  for (const el of deepAll<HTMLElement>(document, OPTION_SELECTOR)) {
    if (before.has(el) || !isRendered(el)) continue;
    // Una <li> que contiene el botón de la opción no cuenta dos veces: gana el elemento más interno.
    if (el.querySelector(OPTION_SELECTOR)) continue;
    const text = squash(el.textContent);
    if (!text || text.length > MAX_OPTION_TEXT) continue;
    const key = normalizeText(text);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(el);
  }
  return found;
}

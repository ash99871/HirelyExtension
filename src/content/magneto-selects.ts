/**
 * Desplegables (select2) de la pantalla «crear cuenta» de Magneto: ciudad de nacimiento y
 * tipo de documento. Su <input> real está oculto, así que el escáner genérico no los ve.
 *
 * Se abre la lista, se escribe en su buscador y se hace clic en la opción que mejor coincide
 * (ciudad + país; tipo de documento por parecido). Solo rellena: NUNCA envía el formulario.
 */
import { isRendered } from "./dom-fields";
import {
  TRIGGER_SELECTOR, clickEl, companionInput, currentText, deepAll, findSearchInput, parentOf, sleep, typeText
} from "./complementary-form";
import type { AutofillValues } from "../shared/field-mapping";
import { normalizeText } from "../shared/text-similarity";
import { pickCityOption, pickDocumentTypeOption, type CandidateOption } from "../shared/option-matching";

export type MagnetoSelectKey = "birth_city" | "document_type";

export interface MagnetoSelectItem {
  readonly key: MagnetoSelectKey;
  readonly label: string;
  /** Texto que se buscaría (ciudad, o tipo de documento del perfil). */
  readonly value: string;
  /** País del perfil, solo para ciudades. */
  readonly country: string;
  readonly control: HTMLElement;
}

export interface MagnetoSelectResult {
  readonly label: string;
  readonly ok: boolean;
  /** Texto de la opción elegida, o motivo si no se pudo. */
  readonly detail: string;
}

const POLL_MS = 250;
const MAX_POLLS = 14; // las ciudades pueden venir de un servidor: hasta ~3,5 s
const MAX_OPTION_TEXT = 160;
const OPTION_SELECTOR = '[role="option"], li';
const CLICKABLE = '[role="option"], li, button, [role="button"], a, label';

/** Pistas de texto y clases de un desplegable: atributos propios + ancestros cercanos. */
function describeTrigger(trigger: HTMLElement): string {
  const parts: string[] = [];
  const companion = companionInput(trigger);
  for (const el of [trigger, companion]) {
    if (!el) continue;
    parts.push(el.getAttribute("name") ?? "", el.id, el.getAttribute("aria-label") ?? "", el.getAttribute("placeholder") ?? "");
    for (const label of Array.from((el as HTMLInputElement).labels ?? [])) parts.push(label.textContent ?? "");
  }
  let node: Element | null = parentOf(trigger);
  for (let depth = 0; node && depth < 6; depth++, node = parentOf(node)) {
    parts.push(node.getAttribute("class") ?? "");
    const text = node.textContent ?? "";
    if (text.length <= 80) parts.push(text);
  }
  return normalizeText(parts.join(" "));
}

function classify(trigger: HTMLElement): MagnetoSelectKey | null {
  const hints = describeTrigger(trigger);
  if (hints.includes("tipo de documento") || hints.includes("tipo documento")) return "document_type";
  // «birthplace» y «city birth» vienen de las clases CSS del contenedor (CSS modules de Magneto).
  if (hints.includes("birthplace") || hints.includes("city birth") || hints.includes("ciudad de nacimiento")) return "birth_city";
  return null;
}

/** Qué desplegables se podrían llenar con el perfil. No toca la página. */
export function planMagnetoSelects(values: AutofillValues): MagnetoSelectItem[] {
  const items: MagnetoSelectItem[] = [];
  const seen = new Set<MagnetoSelectKey>();
  const triggers = deepAll<HTMLElement>(document, TRIGGER_SELECTOR).filter(el => isRendered(el) && !el.hasAttribute("disabled"));
  for (const control of triggers) {
    const key = classify(control);
    if (!key || seen.has(key)) continue;
    const value = key === "document_type" ? values.document_type : values.birth_city;
    if (!value) continue;
    const text = normalizeText(currentText(control));
    // Si el botón ya muestra una elección (no el placeholder), no se pisa.
    const placeholder = normalizeText(control.querySelector("p")?.textContent ?? "");
    const hasChoice = text !== "" && !(key === "birth_city" && text === "ciudad") && !text.includes("selecciona");
    if (hasChoice && placeholder !== "" && text !== placeholder) continue;
    seen.add(key);
    items.push({
      key,
      label: key === "document_type" ? "Tipo de documento" : "Ciudad de nacimiento",
      value,
      country: key === "birth_city" ? values.birth_country ?? "" : "",
      control
    });
  }
  return items;
}

function visibleOptions(before: ReadonlySet<Element>): { el: HTMLElement; text: string }[] {
  const found: { el: HTMLElement; text: string }[] = [];
  for (const el of deepAll<HTMLElement>(document, OPTION_SELECTOR)) {
    if (before.has(el) || !isRendered(el)) continue;
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text && text.length <= MAX_OPTION_TEXT) found.push({ el, text });
  }
  return found;
}

/** Abre el desplegable, escribe en su buscador (si lo tiene) y hace clic en la mejor opción. */
export async function fillMagnetoSelect(item: MagnetoSelectItem, wanted: string): Promise<MagnetoSelectResult> {
  const { control, label } = item;
  const text = wanted.trim();
  if (!text || !control.isConnected) return { label, ok: false, detail: "el campo ya no está en la página" };

  const before = new Set(deepAll<Element>(document, "*"));
  control.focus?.();
  clickEl(control);

  // Documento: la lista es corta y se ve completa. Ciudad: se escribe para filtrar.
  let typed = false;
  for (let poll = 0; poll < MAX_POLLS; poll++) {
    if (item.key === "birth_city" && !typed) {
      const search = findSearchInput(control, before);
      if (search) {
        search.focus();
        typeText(search, text);
        typed = true;
      }
    }
    const options = visibleOptions(before);
    if (options.length && (item.key === "document_type" || typed)) {
      const candidates: CandidateOption[] = options.map(option => ({ text: option.text }));
      if (item.key === "document_type") {
        const index = pickDocumentTypeOption(candidates, text);
        if (index >= 0) return choose(label, options[index]!, true);
      } else {
        const choice = pickCityOption(candidates, text, item.country);
        if (choice) return choose(label, options[choice.index]!, choice.countryConfirmed || item.country === "");
      }
    }
    await sleep(POLL_MS);
  }
  return { label, ok: false, detail: `no encontré «${text}» en la lista` };
}

function choose(label: string, option: { el: HTMLElement; text: string }, confident: boolean): MagnetoSelectResult {
  clickEl((option.el.closest(CLICKABLE) as HTMLElement | null) ?? option.el);
  // Si no se pudo confirmar el país, la persona debe revisar la opción elegida.
  return { label, ok: confident, detail: option.text };
}

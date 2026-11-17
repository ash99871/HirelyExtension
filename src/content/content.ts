/**
 * Content script: orquesta el flujo y delega.
 *
 *   escanear DOM ──► lógica pura (mapeo / detección / matching) ──► llenado DOM + UI
 *   (dom-fields)          (src/shared, sin DOM)                    (dom-fields, assistant-ui)
 *
 * Regla: ningún error debe escapar de este archivo. Todo punto de entrada está protegido y
 * los fallos se muestran en el panel con un mensaje entendible.
 */
import { getEducationRows, getOwnProfile } from "../shared/profile-service";
import { listSavedAnswers, saveAnswer } from "../shared/answers-service";
import { HirelyError, userMessage } from "../shared/errors";
import { matchFieldsToValues, resolveAutofillValues, type AutofillValues } from "../shared/field-mapping";
import { resolveComplementaryValues, type ComplementaryValues } from "../shared/complementary-data";
import { detectOpenQuestions } from "../shared/question-detection";
import { attachSuggestionsCooperative } from "../shared/question-matching";
import { getFreshSession } from "../shared/session";
import { assertExtensionAlive } from "../shared/storage";
import { describeError, log } from "../shared/logger";
import type { FieldDescriptor, FieldMatch, JsonRecord, QuestionSuggestion, SavedAnswer } from "../shared/types";
import {
  applyFieldMatches,
  fillElement,
  fillMagnetoBirthDate,
  findMagnetoBirthDateGroup,
  formatBirthDate,
  scanFormFields,
  type FillableElement
} from "./dom-fields";
import {
  authorizedComplementaryValues,
  fillComplementaryModal,
  isInside,
  planComplementaryModal,
  summarizeComplementary,
  type ComplementaryPlanItem
} from "./complementary-form";
import { mountAssistantUi, type AssistantUi, type ConsentItem, type QuestionCard } from "./assistant-ui";
import { yieldToMain } from "./scheduling";

/** Estado de la ejecución en curso; se descarga al cerrar el panel (no retiene DOM ni respuestas). */
interface RunState {
  readonly elements: ReadonlyMap<string, FillableElement>;
  readonly questions: ReadonlyMap<string, QuestionSuggestion>;
}

let ui: AssistantUi | undefined;
let run: RunState | null = null;
let running = false;

interface AssistantData {
  readonly values: AutofillValues;
  readonly complementary: ComplementaryValues;
  readonly answers: SavedAnswer[];
}

async function loadAssistantData(): Promise<AssistantData | null> {
  const session = await getFreshSession();
  if (!session) return null;

  const [profile, answers] = await Promise.all([
    getOwnProfile(session.user.id),
    // Sin la tabla saved_answers el autocompletado del perfil debe seguir funcionando.
    listSavedAnswers(100).catch((error: unknown) => {
      if (HirelyError.is(error, "MISSING_TABLE")) return [] as SavedAnswer[];
      throw error;
    })
  ]);
  if (!profile) throw new HirelyError("NOT_FOUND");
  // El nivel de estudios vive en otra tabla: si falla, el resto del autocompletado sigue funcionando.
  const profileId = String(profile["id"] ?? "");
  const education = profileId
    ? await getEducationRows(profileId).catch((): JsonRecord[] => [])
    : [];
  // Del perfil completo solo se conserva lo necesario para autocompletar.
  return {
    values: resolveAutofillValues(profile),
    complementary: resolveComplementaryValues(profile, education),
    answers
  };
}

async function runAssistant(): Promise<void> {
  if (running || !ui) return;
  running = true;
  const panel = ui;
  panel.openPanel();
  panel.setStatus("Buscando campos y respuestas guardadas…");
  try {
    assertExtensionAlive();
    const data = await loadAssistantData();
    if (!panel.isPanelOpen()) return; // el usuario cerró el panel mientras cargaba
    if (!data) {
      panel.setStatus(userMessage(new HirelyError("AUTH_REQUIRED")), "error");
      return;
    }

    // 1. Calcular qué se llenaría, SIN tocar la página: el modal de datos complementarios y el resto.
    const plan = planComplementaryModal(data.complementary);
    const modal = plan.modal;
    // Fecha de nacimiento de Magneto: 8 casillas de un dígito. Se maneja aparte y se excluye del escaneo genérico.
    const birthDate = data.values.birth_date ? formatBirthDate(data.values.birth_date) : null;
    const birthGroup = birthDate ? findMagnetoBirthDateGroup() : null;
    const scan = await scanFormFields(document, {
      exclude: el => (modal !== null && isInside(modal, el)) || (birthGroup?.includes(el as HTMLInputElement) ?? false)
    });
    const matches = matchFieldsToValues(data.values, scan.fields);
    if (!panel.isPanelOpen()) return;

    // 2. Pedir autorización. Nada se escribe en la página hasta que la persona acepta.
    const consent = buildConsent(plan.items, matches, scan.fields);
    if (birthDate && birthGroup) consent.items.push({ id: BIRTH_DATE_ID, label: "Fecha de nacimiento", value: birthDate, editable: true });
    let filledIds: ReadonlySet<string> = new Set();
    let headline: string;
    if (!consent.items.length) {
      headline = `No encontramos campos que podamos llenar con tu perfil.${plan.modal ? summarizeComplementary({ modal: plan.modal, steps: [] }) : ""}`;
    } else {
      panel.setStatus(""); // el título de la lista ya explica qué hacer
      const approvals = await panel.requestConsent(consent.items);
      if (!panel.isPanelOpen()) return;
      if (!approvals) {
        headline = "No se llenó ningún campo.";
      } else {
        // 3. Llenar SOLO lo autorizado, con los valores que la persona dejó.
        const approved = new Map(approvals.map(item => [item.id, item.value]));
        const complementaryItems = consent.complementary
          .filter(entry => approved.has(entry.id))
          .map(entry => ({ ...entry.item, value: approved.get(entry.id) ?? entry.item.value }));
        const complementary = complementaryItems.length
          ? await fillComplementaryModal(authorizedComplementaryValues(complementaryItems))
          : { modal: null, steps: [] };
        if (!panel.isPanelOpen()) return;
        const fieldMatches = matches
          .filter(match => approved.has(match.fieldId))
          .map(match => (consent.editable.has(match.fieldId) ? { ...match, value: approved.get(match.fieldId) ?? match.value } : match));
        const report = applyFieldMatches(fieldMatches, scan.elements);
        filledIds = report.filled;
        const approvedBirthDate = approved.get(BIRTH_DATE_ID);
        const birthDateFilled = approvedBirthDate !== undefined && fillMagnetoBirthDate(approvedBirthDate, birthGroup);
        const birthDateNote = approvedBirthDate !== undefined && !birthDateFilled ? " Revisar: fecha de nacimiento (usa DD/MM/AAAA)." : "";
        headline = `Autocompletado: ${report.filled.size + (birthDateFilled ? 1 : 0)} campo(s).${summarizeComplementary(complementary)}${birthDateNote}`;
      }
    }

    // Un campo recién autocompletado ya no es una "pregunta abierta vacía".
    const remaining = scan.fields.filter(field => !filledIds.has(field.id));
    const questions = detectOpenQuestions(remaining);
    const suggestions = await attachSuggestionsCooperative(questions, data.answers, { yieldFn: yieldToMain });
    if (!panel.isPanelOpen()) return;

    run = { elements: scan.elements, questions: new Map(suggestions.map(item => [item.fieldId, item])) };
    log.info("assistant.done", { fields: scan.fields.length, offered: consent.items.length, filled: filledIds.size, questions: questions.length, truncated: scan.truncated });
    panel.setStatus(`${headline} Preguntas abiertas detectadas: ${questions.length}.`);
    panel.renderQuestions(suggestions.map(toCard));
  } catch (error) {
    log.warn("assistant.failed", describeError(error));
    panel.setStatus(userMessage(error), "error");
  } finally {
    running = false;
  }
}

/** Id de la fila de la fecha de nacimiento de Magneto en la lista de autorización. */
const BIRTH_DATE_ID = "birth-date";

interface ConsentPlan {
  readonly items: ConsentItem[];
  /** Datos del modal de Magneto, con el id que llevan en la lista de autorización. */
  readonly complementary: { readonly id: string; readonly item: ComplementaryPlanItem }[];
  /** ids de campos cuyo valor se puede corregir (texto libre; un <select> no). */
  readonly editable: ReadonlySet<string>;
}

/** Une lo que se llenaría en el modal y en el resto de la página en una sola lista para autorizar. */
function buildConsent(
  complementaryItems: readonly ComplementaryPlanItem[],
  matches: readonly FieldMatch[],
  fields: readonly FieldDescriptor[]
): ConsentPlan {
  const items: ConsentItem[] = [];
  const complementary: ConsentPlan["complementary"][number][] = [];
  const editable = new Set<string>();

  complementaryItems.forEach((item, index) => {
    const id = `cx-${index + 1}`;
    complementary.push({ id, item });
    items.push({
      id,
      label: item.key === "preference" ? "Preferencia" : item.target,
      value: item.value,
      editable: item.key !== "preference"
    });
  });

  const byId = new Map(fields.map(field => [field.id, field]));
  for (const match of matches) {
    const field = byId.get(match.fieldId);
    const isSelect = field?.kind === "select";
    // En un <select> se muestra el texto de la opción, no su value interno («Colombia», no «CO»).
    const shown = isSelect ? field.options.find(option => option.value === match.value)?.label ?? match.value : match.value;
    if (!isSelect) editable.add(match.fieldId);
    items.push({ id: match.fieldId, label: match.label || "Campo", value: shown, editable: !isSelect });
  }
  return { items, complementary, editable };
}

function toCard(item: QuestionSuggestion): QuestionCard {
  return {
    id: item.fieldId,
    label: item.label,
    initialAnswer: item.suggestedAnswer?.answer_text ?? "",
    ...(item.similarity === undefined ? {} : { similarity: item.similarity })
  };
}

/** Inserta la respuesta en la página. Devuelve `true` si quedó escrita (el panel quita entonces su tarjeta). */
function useAnswer(cardId: string, text: string): boolean {
  const element = run?.elements.get(cardId);
  if (!element) {
    ui?.setStatus("Este campo ya no está disponible en la página.", "error");
    return false;
  }
  // Acción explícita del usuario ("Usar respuesta"): sí se permite sustituir el contenido.
  const outcome = fillElement(element, text, { overwrite: true });
  if (outcome === "filled") {
    ui?.setStatus("Respuesta insertada.");
    return true;
  }
  ui?.setStatus("No se pudo insertar: el campo ya no está disponible o está deshabilitado.", "error");
  return false;
}

async function saveForLater(cardId: string, text: string): Promise<boolean> {
  const question = run?.questions.get(cardId);
  if (!question) return false;
  try {
    await saveAnswer({ question_text: question.question, answer_text: text, context: location.hostname });
    ui?.setStatus("Respuesta guardada en tu cuenta.");
    return true;
  } catch (error) {
    log.warn("save.failed", describeError(error));
    ui?.setStatus(userMessage(error), "error");
    return false;
  }
}

function bootstrap(): void {
  // Solo páginas HTML (no visores de PDF/imagen/XML) y con documentElement disponible.
  if (document.contentType !== "text/html" || !document.documentElement) return;

  ui = mountAssistantUi({
    onLaunch: () => void runAssistant(),
    onUseAnswer: useAnswer,
    onSaveAnswer: saveForLater,
    onClosed: () => {
      run = null;
    }
  });

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (typeof message === "object" && message !== null && (message as { type?: unknown }).type === "HIRELY_AUTOFILL") {
      void runAssistant();
      sendResponse({ ok: true }); // sin respuesta, sendMessage del popup rechaza con "message port closed"
    }
    return false;
  });
}

try {
  bootstrap();
} catch (error) {
  // Un fallo de Hirely nunca debe afectar a la página que se está visitando.
  log.error("bootstrap.failed", describeError(error));
}

export function initMagnetoObserver(onFormDetected: () => void): void {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        const formElement = document.querySelector('form, [class*="question"], [class*="form"]');
        if (formElement) {
          onFormDetected();
          break;
        }
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

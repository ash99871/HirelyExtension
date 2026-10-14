/**
 * Content script: orquesta el flujo y delega.
 *
 *   escanear DOM ──► lógica pura (mapeo / detección / matching) ──► llenado DOM + UI
 *   (dom-fields)          (src/shared, sin DOM)                    (dom-fields, assistant-ui)
 *
 * Regla: ningún error debe escapar de este archivo. Todo punto de entrada está protegido y
 * los fallos se muestran en el panel con un mensaje entendible.
 */
import { getOwnProfile } from "../shared/profile-service";
import { listSavedAnswers, saveAnswer } from "../shared/answers-service";
import { HirelyError, userMessage } from "../shared/errors";
import { matchFieldsToValues, resolveAutofillValues, type AutofillValues } from "../shared/field-mapping";
import { detectOpenQuestions } from "../shared/question-detection";
import { attachSuggestionsCooperative } from "../shared/question-matching";
import { getFreshSession } from "../shared/session";
import { assertExtensionAlive } from "../shared/storage";
import { describeError, log } from "../shared/logger";
import type { QuestionSuggestion, SavedAnswer } from "../shared/types";
import { applyFieldMatches, fillElement, scanFormFields, type FillableElement } from "./dom-fields";
import { mountAssistantUi, type AssistantUi, type QuestionCard } from "./assistant-ui";
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
  // Del perfil completo solo se conserva lo necesario para autocompletar.
  return { values: resolveAutofillValues(profile), answers };
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

    const scan = await scanFormFields();
    const matches = matchFieldsToValues(data.values, scan.fields);
    const report = applyFieldMatches(matches, scan.elements);

    // Un campo recién autocompletado ya no es una "pregunta abierta vacía".
    const remaining = scan.fields.filter(field => !report.filled.has(field.id));
    const questions = detectOpenQuestions(remaining);
    const suggestions = await attachSuggestionsCooperative(questions, data.answers, { yieldFn: yieldToMain });
    if (!panel.isPanelOpen()) return;

    run = { elements: scan.elements, questions: new Map(suggestions.map(item => [item.fieldId, item])) };
    log.info("assistant.done", { fields: scan.fields.length, filled: report.filled.size, questions: questions.length, truncated: scan.truncated });
    panel.setStatus(`Autocompletado: ${report.filled.size} campo(s). Preguntas abiertas detectadas: ${questions.length}.`);
    panel.renderQuestions(suggestions.map(toCard));
  } catch (error) {
    log.warn("assistant.failed", describeError(error));
    panel.setStatus(userMessage(error), "error");
  } finally {
    running = false;
  }
}

function toCard(item: QuestionSuggestion): QuestionCard {
  return {
    id: item.fieldId,
    label: item.label,
    initialAnswer: item.suggestedAnswer?.answer_text ?? "",
    ...(item.similarity === undefined ? {} : { similarity: item.similarity })
  };
}

function useAnswer(cardId: string, text: string): void {
  const element = run?.elements.get(cardId);
  if (!element) return void ui?.setStatus("Este campo ya no está disponible en la página.", "error");
  // Acción explícita del usuario ("Usar respuesta"): sí se permite sustituir el contenido.
  const outcome = fillElement(element, text, { overwrite: true });
  if (outcome === "filled") ui?.setStatus("Respuesta insertada. Revisa el formulario antes de enviarlo.");
  else ui?.setStatus("No se pudo insertar: el campo ya no está disponible o está deshabilitado.", "error");
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

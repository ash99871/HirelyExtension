/**
 * Content script: orquesta el flujo y delega.
 *
 *   1. Leer el formulario abierto, SIN tocarlo: qué datos del perfil encajan (campos normales,
 *      modal de datos complementarios de Magneto, fecha de nacimiento) y qué campos quedan sin
 *      respuesta (preguntas: texto, listas, opciones…).
 *   2. Mostrarlo todo en el panel y esperar la autorización.
 *   3. Llenar SOLO lo autorizado y respondido.
 *   4. Revisar qué quedó vacío: volver a preguntar lo que falta, o mostrar «Todo listo».
 *   5. Recordar las respuestas nuevas, si la persona quiere, para la próxima vez.
 *
 * Regla: ningún error debe escapar de este archivo. Todo punto de entrada está protegido y
 * los fallos se muestran en el panel con un mensaje entendible.
 */
import { getEducationRows, getOwnProfile } from "../shared/profile-service";
import { listSavedAnswers, saveAnswer } from "../shared/answers-service";
import { HirelyError, userMessage } from "../shared/errors";
import { matchFieldsToValues, resolveAutofillValues, type AutofillValues } from "../shared/field-mapping";
import { resolveComplementaryValues, type ComplementaryValues } from "../shared/complementary-data";
import {
  STRONG_SIMILARITY,
  answerText,
  formatDate,
  profileProposal,
  savedProposal,
  shouldRemember,
  type PageQuestion,
  type QuestionAnswer
} from "../shared/form-questions";
import { buildAnswerIndex, type AnswerIndexEntry } from "../shared/question-matching";
import { getFreshSession } from "../shared/session";
import { assertExtensionAlive } from "../shared/storage";
import { describeError, log } from "../shared/logger";
import type { JsonRecord, SavedAnswer } from "../shared/types";
import { fillDigitDate, fillElement, fillPhone, findDigitDateGroups, scanFormFields } from "./dom-fields";
import {
  authorizedComplementaryValues,
  fillComplementaryModal,
  planComplementaryModal,
  type ComplementaryPlanItem,
  type StepStatus
} from "./complementary-form";
import {
  applyAnswer,
  collectQuestions,
  countPendingFields,
  findFormScope,
  isFormNoise,
  type ProbeResult,
  type ScannedQuestion
} from "./page-questions";
import { mountAssistantUi, type AskItem, type AssistantUi, type ConsentItem, type ReviewResult } from "./assistant-ui";

let ui: AssistantUi | undefined;
let running = false;

/** Rondas de «faltan campos» después de la primera revisión. */
const MAX_ROUNDS = 3;
const OK_STEPS: ReadonlySet<StepStatus> = new Set(["filled", "selected", "already-selected", "already-filled"]);

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

/* ------------------------------ 1. leer el formulario ------------------------------ */

/** Datos del perfil que encajan en el formulario, y cómo escribir cada uno. */
interface ProfilePlan {
  readonly found: ConsentItem[];
  /** id de la fila → cómo escribirla (campos normales, fecha de nacimiento, preguntas con dato del perfil). */
  readonly writers: Map<string, (value: string) => Promise<boolean>>;
  /** Filas del modal de datos complementarios: se llenan juntas con su adaptador. */
  readonly modal: { readonly id: string; readonly item: ComplementaryPlanItem }[];
  readonly handled: Set<Element>;
}

async function planProfile(scope: ParentNode, data: AssistantData): Promise<ProfilePlan> {
  const found: ConsentItem[] = [];
  const writers = new Map<string, (value: string) => Promise<boolean>>();
  const handled = new Set<Element>();

  // Modal de datos complementarios de Magneto (sector, cargo, salario, ciudad, preferencias…).
  const modalPlan = planComplementaryModal(data.complementary);
  for (const el of modalPlan.handled) handled.add(el);
  const modal = modalPlan.items.map((item, index) => {
    const id = `cx-${index + 1}`;
    found.push({ id, label: item.key === "preference" ? "Preferencia" : item.target, value: item.value, editable: item.key !== "preference" });
    return { id, item };
  });

  // Fechas de 8 casillas: la de nacimiento sale del perfil; las demás se preguntan.
  const digitBoxes = new Set<Element>();
  for (const group of findDigitDateGroups(scope)) {
    for (const input of group.inputs) digitBoxes.add(input);
    const birth = data.values.birth_date ? formatDate(data.values.birth_date) : null;
    if (group.isBirthDate && group.empty && birth && !writers.has("birth-date")) {
      found.push({ id: "birth-date", label: "Fecha de nacimiento", value: birth, editable: true });
      writers.set("birth-date", async value => fillDigitDate(value, group.inputs));
      for (const input of group.inputs) handled.add(input);
    }
  }

  // Campos normales con un dato del perfil (nombre, correo, celular, país…).
  const scan = await scanFormFields(scope, {
    exclude: el => handled.has(el) || digitBoxes.has(el) || isFormNoise(el, scope)
  });
  const byId = new Map(scan.fields.map(field => [field.id, field]));
  for (const match of matchFieldsToValues(data.values, scan.fields)) {
    const element = scan.elements.get(match.fieldId);
    const field = byId.get(match.fieldId);
    if (!element || !field) continue;
    const isSelect = field.kind === "select";
    // En un <select> se muestra el texto de la opción, no su value interno («Colombia», no «CO»).
    const shown = isSelect ? field.options.find(option => option.value === match.value)?.label ?? match.value : match.value;
    found.push({ id: match.fieldId, label: match.label || "Campo", value: shown, editable: !isSelect });
    writers.set(match.fieldId, async value =>
      match.key === "phone" && !isSelect ? fillPhone(element, value) : fillElement(element, isSelect ? match.value : value) === "filled");
    handled.add(element);
  }
  return { found, writers, modal, handled };
}

/* ------------------------------ 2. armar la revisión ------------------------------ */

interface Review {
  readonly found: ConsentItem[];
  readonly ask: AskItem[];
  readonly writers: Map<string, (value: string) => Promise<boolean>>;
  readonly questions: Map<string, ScannedQuestion>;
}

const FAILED_NOTE = "No pudimos llenarlo. Prueba con otra respuesta o llénalo directamente en la página.";

function toAskItem(question: PageQuestion, extra: Partial<AskItem> = {}): AskItem {
  return {
    id: question.id, label: question.label, kind: question.kind, options: question.options,
    required: question.required, optional: question.optional, sensitive: question.sensitive,
    searchable: question.searchable, inputType: question.inputType, ...extra
  };
}

/**
 * Cada pregunta se propone con un dato del perfil (va a «Encontramos…»), con una respuesta
 * guardada (va a «Necesitamos tu respuesta», ya escrita o sugerida) o queda para la persona.
 */
function buildReview(
  plan: ProfilePlan | null,
  items: readonly ScannedQuestion[],
  data: AssistantData,
  index: readonly AnswerIndexEntry[],
  failed: ReadonlySet<Element>,
  failedNotes: ReadonlyMap<Element, string> = new Map()
): Review {
  const found = [...(plan?.found ?? [])];
  const writers = new Map(plan?.writers ?? []);
  const ask: AskItem[] = [];
  const questions = new Map<string, ScannedQuestion>();

  for (const scanned of items) {
    const { question, handle } = scanned;
    questions.set(question.id, scanned);
    const note = failed.has(scanned.anchor) ? { note: failedNotes.get(scanned.anchor) ?? FAILED_NOTE } : {};

    const fromProfile = failed.has(scanned.anchor) ? null : profileProposal(question, data.values);
    if (fromProfile) {
      const option = fromProfile.optionIds?.length ? question.options.find(o => o.id === fromProfile.optionIds![0]) : undefined;
      found.push({ id: question.id, label: question.label, value: option?.label ?? fromProfile.text ?? "", editable: !option, multiline: question.kind === "long-text" });
      writers.set(question.id, value =>
        applyAnswer(handle, option ? { id: question.id, optionIds: [option.id] } : { id: question.id, text: value }));
      continue;
    }

    const saved = savedProposal(question, index);
    if (saved && (saved.similarity ?? 0) >= STRONG_SIMILARITY) {
      ask.push(toAskItem(question, { initial: saved, ...note }));
    } else if (saved) {
      ask.push(toAskItem(question, { suggestion: { answer: saved, text: answerText(question, saved) }, ...note }));
    } else {
      ask.push(toAskItem(question, note));
    }
  }
  return { found, ask, writers, questions };
}

/* ------------------------------ 3. llenar ------------------------------ */

interface FillOutcome {
  filled: number;
  readonly notes: string[];
  /** Preguntas a las que la persona respondió en esta ronda. */
  readonly answered: Set<Element>;
  /**
   * Campos del modal de Magneto que no se pudieron llenar con el dato del perfil (p. ej. Sector
   * «Datos», que no es una opción): se vuelven a preguntar con las opciones reales y este aviso.
   */
  readonly retry: Map<Element, string>;
}

async function fillAuthorized(
  review: Review,
  plan: ProfilePlan | null,
  result: ReviewResult,
  data: AssistantData
): Promise<FillOutcome> {
  const outcome: FillOutcome = { filled: 0, notes: [], answered: new Set(), retry: new Map() };
  const approved = new Map(result.approvals.map(item => [item.id, item.value]));
  const labels = new Map(review.found.map(item => [item.id, item.label]));

  // Modal de Magneto: todo junto, con su adaptador.
  const modalItems = (plan?.modal ?? [])
    .filter(entry => approved.has(entry.id))
    .map(entry => ({ ...entry.item, value: approved.get(entry.id) ?? entry.item.value }));
  if (modalItems.length) {
    const result = await fillComplementaryModal(authorizedComplementaryValues(modalItems, data.complementary));
    const wanted = new Map(modalItems.map(item => [item.target, item.value]));
    for (const step of result.steps) {
      const control = result.controls?.get(step.target);
      if (OK_STEPS.has(step.status)) {
        outcome.filled++;
        // La ciudad se informa siempre: hay ciudades con el mismo nombre en otros países.
        if (step.target === "Ciudad" && step.detail) outcome.notes.push(`Ciudad: elegimos «${step.detail.slice(0, 70)}». Verifica que sea la correcta.`);
      } else if (step.status === "selected-approx" && step.detail) {
        outcome.filled++;
        outcome.notes.push(`Revisa «${step.target}»: elegimos «${step.detail.slice(0, 70)}».`);
      } else if (control) {
        // No se pudo: se vuelve a preguntar ya, con las opciones que de verdad tiene Magneto.
        const value = wanted.get(step.target);
        outcome.retry.set(control, !value
          ? FAILED_NOTE
          : step.target === "Ciudad"
            ? `No encontramos «${value.slice(0, 50)}» de tu país en la lista de Magneto. Escríbela con su departamento (por ejemplo «Medellín, Antioquia») y elegimos esa.`
            : `Tu perfil dice «${value.slice(0, 50)}» y Magneto no tiene esa opción. Elige la que corresponda.`);
      } else {
        outcome.notes.push(`Revisa «${step.target}»: no lo pudimos llenar.`);
      }
    }
  }

  // Datos del perfil (campos normales, fecha de nacimiento, preguntas con dato del perfil).
  for (const [id, value] of approved) {
    const write = review.writers.get(id);
    if (!write) continue;
    if (await write(value)) outcome.filled++;
    else outcome.notes.push(`No pudimos llenar «${labels.get(id) ?? "un campo"}».`);
  }

  // Respuestas de la persona.
  for (const answer of result.answers) {
    const scanned = review.questions.get(answer.id);
    if (!scanned) continue;
    outcome.answered.add(scanned.anchor);
    if (await applyAnswer(scanned.handle, answer)) outcome.filled++;
  }
  return outcome;
}

/* ------------------------------ 5. recordar ------------------------------ */

async function rememberAnswers(answers: readonly QuestionAnswer[], review: Review, saved: SavedAnswer[]): Promise<string | null> {
  for (const answer of answers) {
    const question = review.questions.get(answer.id)?.question;
    if (!question) continue;
    const text = answerText(question, answer);
    if (!shouldRemember(question, text, saved)) continue;
    try {
      const row = await saveAnswer({ question_text: question.label, answer_text: text, category: "Formulario", context: location.hostname });
      saved.unshift(row);
    } catch (error) {
      if (HirelyError.is(error, "MISSING_TABLE")) return null;
      log.warn("remember.failed", describeError(error));
      return "No pudimos guardar tus respuestas para la próxima vez.";
    }
  }
  return null;
}

/* ------------------------------ flujo completo ------------------------------ */

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

    const saved = [...data.answers];
    const probeCache = new Map<string, ProbeResult>();
    const asked = new Set<Element>();
    let failed: ReadonlySet<Element> = new Set();
    let failedNotes: ReadonlyMap<Element, string> = new Map();
    let filled = 0;
    const notes: string[] = [];

    for (let round = 0; round <= MAX_ROUNDS; round++) {
      panel.setStatus(round === 0 ? "Revisando el formulario…" : "Revisando qué quedó vacío…");
      const scope = findFormScope();
      const plan = round === 0 ? await planProfile(scope, data) : null;
      const scan = await collectQuestions(scope, {
        isHandled: el => plan?.handled.has(el) ?? false,
        probeCache,
        onProgress: message => panel.setStatus(message)
      });
      if (!panel.isPanelOpen()) return;

      // Después de llenar, se vuelve a preguntar solo lo que importa: lo que falló, lo obligatorio
      // y los campos nuevos (p. ej. los que aparecen al responder «Sí»). Lo opcional que la persona
      // dejó en blanco no se vuelve a pedir.
      const items = round === 0
        ? scan.items
        : scan.items.filter(item => failed.has(item.anchor) || !asked.has(item.anchor) || (item.question.required && !item.question.sensitive));
      const review = buildReview(plan, items, data, buildAnswerIndex(saved), failed, failedNotes);
      if (!review.found.length && !review.ask.length) {
        if (round === 0) return panel.showNothingFound();
        break;
      }

      panel.setStatus("");
      const result = await panel.requestReview({
        found: review.found,
        ask: review.ask,
        ...(round === 0 ? {} : { askTitle: `Faltan ${review.ask.length} ${review.ask.length === 1 ? "campo" : "campos"} por llenar` }),
        cancelLabel: round === 0 ? "Cancelar" : "Terminar"
      });
      if (!panel.isPanelOpen()) return;
      // Lo ofrecido (preguntas y datos del perfil) ya se mostró: si la persona lo quitó, no se vuelve a pedir.
      for (const item of items) asked.add(item.anchor);
      for (const el of plan?.handled ?? []) asked.add(el);
      if (!result) {
        if (round === 0) {
          return panel.showDone({ title: "No se llenó nada", text: "Cancelaste el autocompletado. Pulsa H cuando quieras intentarlo de nuevo." });
        }
        break;
      }

      panel.setStatus("Llenando el formulario…");
      const outcome = await fillAuthorized(review, plan, result, data);
      if (!panel.isPanelOpen()) return;
      filled += outcome.filled;
      notes.push(...outcome.notes);
      failed = new Set([...outcome.answered, ...outcome.retry.keys()]);
      failedNotes = outcome.retry;
      if (result.remember) {
        const problem = await rememberAnswers(result.answers, review, saved);
        if (problem && !notes.includes(problem)) notes.push(problem);
      }
    }

    // Revisión final: qué quedó vacío y qué debe hacer la persona (p. ej. adjuntar archivos).
    const final = await collectQuestions(findFormScope(), { probe: false, probeCache });
    if (!panel.isPanelOpen()) return;
    const empty = final.items.map(item => item.question);
    const missingRequired = empty.filter(question => question.required);
    const details = [
      ...notes,
      ...empty.slice(0, 6).map(question => `Sin responder: ${question.label}${question.required ? " (obligatorio)" : ""}`),
      ...(empty.length > 6 ? [`…y ${empty.length - 6} más.`] : []),
      ...final.files.map(file => `Adjunta tú: ${file}`)
    ];
    log.info("assistant.done", { filled, empty: empty.length, files: final.files.length });
    panel.showDone({
      title: missingRequired.length ? "Casi listo" : "Todo listo",
      text: filled
        ? `Llenamos ${filled} ${filled === 1 ? "campo" : "campos"}. Revisa el formulario y envíalo cuando quieras.`
        : "No se llenó ningún campo.",
      details
    });
  } catch (error) {
    log.warn("assistant.failed", describeError(error));
    panel.setStatus(userMessage(error), "error");
  } finally {
    running = false;
  }
}

/* ------------------------------ aviso «Formulario detectado» ------------------------------ */

/**
 * Observa la página y, cuando aparece un formulario con campos vacíos (una ventana de Magneto,
 * el siguiente paso de una postulación…), muestra «Formulario detectado · N campos» junto al
 * botón H. No abre listas ni toca nada: solo cuenta.
 */
function watchForms(host: Element): void {
  let timer: number | undefined;
  let lastScope: ParentNode | null = null;
  let lastCount = 0;
  const check = (): void => {
    timer = undefined;
    if (running || !ui) return;
    try {
      const scope = findFormScope();
      // En la página completa, solo cuentan los campos dentro de un <form> (no buscadores ni filtros).
      const count = countPendingFields(scope, { formsOnly: scope === document });
      // Solo se avisa si aparece OTRO formulario o campos NUEVOS. Que baje el número (porque se
      // llenaron campos, o la persona dejó alguno en blanco a propósito) no es «algo nuevo».
      if (scope !== lastScope || count > lastCount || count === 0) ui.setDetected(count);
      lastScope = scope;
      lastCount = count;
    } catch (error) {
      log.warn("watch.failed", describeError(error));
    }
  };
  const observer = new MutationObserver(mutations => {
    if (mutations.every(mutation => mutation.target === host || host.contains(mutation.target))) return;
    if (timer === undefined) timer = window.setTimeout(check, 900);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  check();
}

function bootstrap(): void {
  // Solo páginas HTML (no visores de PDF/imagen/XML) y con documentElement disponible.
  if (document.contentType !== "text/html" || !document.documentElement) return;

  ui = mountAssistantUi({
    onLaunch: () => void runAssistant(),
    onClosed: () => undefined
  });

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (typeof message === "object" && message !== null && (message as { type?: unknown }).type === "HIRELY_AUTOFILL") {
      void runAssistant();
      sendResponse({ ok: true }); // sin respuesta, sendMessage del popup rechaza con "message port closed"
    }
    return false;
  });

  const host = document.getElementById("hirely-assistant-root");
  if (host) watchForms(host);
}

try {
  bootstrap();
} catch (error) {
  // Un fallo de Hirely nunca debe afectar a la página que se está visitando.
  log.error("bootstrap.failed", describeError(error));
}

/**
 * Preguntas del formulario. LÓGICA PURA (sin DOM ni `chrome`).
 *
 * Todo campo vacío del formulario que Hirely no puede llenar desde el perfil se le pregunta a la
 * persona en el panel. Este módulo decide, sobre datos planos:
 *   - cómo se llama la pregunta (etiqueta limpia), si es obligatoria y si es un dato sensible;
 *   - qué respuesta proponer: un dato del perfil o una respuesta que la persona ya guardó;
 *   - cómo leer y escribir fechas (DD/MM/AAAA ↔ AAAA-MM-DD).
 *
 * Los datos sensibles (discapacidad, orientación sexual, etnia, salud, religión…) se preguntan,
 * pero NUNCA se proponen ni se recuerdan: los responde siempre la persona.
 */
import { matchFieldsToValues, type AutofillValues } from "./field-mapping";
import { bestSavedAnswer, type AnswerIndexEntry } from "./question-matching";
import { optionCoverageScore } from "./complementary-data";
import { normalizeText, tokenize } from "./text-similarity";
import type { FieldDescriptor, SavedAnswer } from "./types";

/**
 * - text / long-text / date: se escribe (long-text = respuesta larga; date = DD/MM/AAAA).
 * - choice: se elige UNA opción (lista, botones, radios).
 * - multi: se pueden elegir VARIAS (casillas, botones de disponibilidad).
 * - checkbox: una casilla suelta (marcar o no).
 */
export type QuestionKind = "text" | "long-text" | "date" | "choice" | "multi" | "checkbox";

export interface QuestionOption {
  readonly id: string;
  readonly label: string;
}

export interface PageQuestion {
  /** Id opaco: el content script lo usa para volver al control real. */
  readonly id: string;
  readonly kind: QuestionKind;
  /** Pregunta tal como la verá la persona (sin «*» ni «(opcional)»). */
  readonly label: string;
  readonly required: boolean;
  /** Marcada explícitamente como opcional en la página. */
  readonly optional: boolean;
  readonly sensitive: boolean;
  readonly options: readonly QuestionOption[];
  /** Lista con buscador cuyas opciones no se ven hasta escribir (p. ej. «Cargo»): se escribe y se elige la más parecida. */
  readonly searchable: boolean;
  /** `type` del input (email, tel, number, url…), para el teclado del panel. "" si no aplica. */
  readonly inputType: string;
}

/** Respuesta de la persona (o propuesta de Hirely) para una pregunta. */
export interface QuestionAnswer {
  readonly id: string;
  /** text / long-text / date, y listas con buscador. */
  readonly text?: string;
  /** choice (una) / multi (varias). */
  readonly optionIds?: readonly string[];
  /** checkbox. */
  readonly checked?: boolean;
}

export interface Proposal extends QuestionAnswer {
  readonly source: "profile" | "saved";
  /** Parecido con la pregunta guardada (0‒1), solo para respuestas guardadas. */
  readonly similarity?: number;
}

/* ------------------------------ etiquetas ------------------------------ */

const OPTIONAL_MARK = /\(\s*(opcional|optional)\s*\)|\bopcional\b/i;
const REQUIRED_MARK = /\*|\(\s*(obligatori[oa]|requerid[oa]|required)\s*\)|\bobligatori[oa]\b/i;

/** «¿Con cuál género te identificas? (opcional)» → «¿Con cuál género te identificas?». */
export function cleanQuestionLabel(raw: string): string {
  return raw
    .replace(/\(\s*(opcional|optional|obligatori[oa]|requerid[oa]|required)\s*\)/gi, " ")
    .replace(/\*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[\s:]+$/, "")
    .trim()
    .slice(0, 180);
}

export function labelSaysOptional(raw: string): boolean {
  return OPTIONAL_MARK.test(raw);
}

export function labelSaysRequired(raw: string): boolean {
  return !labelSaysOptional(raw) && REQUIRED_MARK.test(raw);
}

/**
 * Datos sensibles (Ley 1581 de 2012: salud, origen étnico, orientación sexual, convicciones,
 * pertenencia a grupos) y otros que solo la persona debe decidir. Se preguntan; nunca se proponen.
 */
const SENSITIVE = new RegExp("\\b(" + [
  "discapacidad", "disability", "orientacion sexual", "sexual orientation", "identidad de genero",
  "etni\\w*", "ethnic\\w*", "raza", "race", "racial", "afro\\w*", "indigena", "grupo poblacional",
  "poblacion vulnerable", "religi\\w*", "salud", "health", "enfermedad\\w*", "diagnostic\\w*",
  "embaraz\\w*", "victima\\w*", "desplazad\\w*", "sindica\\w*", "politic\\w*", "biometric\\w*",
  "antecedentes", "lgbt\\w*"
].join("|") + ")\\b");

export function isSensitiveQuestion(label: string): boolean {
  return SENSITIVE.test(normalizeText(label));
}

/** Grupos de botones donde se suele poder marcar varias opciones (disponibilidad, modalidad, idiomas…). */
const MULTI_HINT = /\b(disponibilidad|modalidad|modalidades|jornada|jornadas|dias|horario|horarios|idiomas|habilidades|competencias|varias|todas las que|puedes elegir varias|puedes seleccionar varias|puedes marcar varias)\b/;

export function looksMultiChoice(label: string): boolean {
  return MULTI_HINT.test(normalizeText(label));
}

/* ------------------------------ opciones ------------------------------ */

/**
 * Opción que corresponde a un texto: exacta; luego por prefijo («Soltero» ↔ «Soltero(a)»);
 * luego la que más palabras comparte (al menos 60 %). null si nada se parece con claridad.
 */
export function findOption(options: readonly QuestionOption[], text: string): QuestionOption | null {
  const target = normalizeText(text);
  if (!target) return null;
  const exact = options.find(option => normalizeText(option.label) === target);
  if (exact) return exact;
  const prefix = options.find(option => {
    const label = normalizeText(option.label);
    return label.startsWith(`${target} `) || target.startsWith(`${label} `);
  });
  if (prefix) return prefix;
  let best: { option: QuestionOption; score: number } | null = null;
  for (const option of options) {
    const score = optionCoverageScore(option.label, text);
    if (score >= 0.6 && (!best || score > best.score)) best = { option, score };
  }
  return best?.option ?? null;
}

/** Texto legible de una respuesta («Femenino», «Remoto, Híbrido», «Sí»), para guardarla o mostrarla. */
export function answerText(question: PageQuestion, answer: QuestionAnswer): string {
  if (question.kind === "checkbox") return answer.checked ? "Sí" : "No";
  if (answer.optionIds?.length) {
    return answer.optionIds
      .map(id => question.options.find(option => option.id === id)?.label ?? "")
      .filter(Boolean)
      .join(", ");
  }
  return answer.text?.trim() ?? "";
}

export function isAnswered(answer: QuestionAnswer | undefined): boolean {
  if (!answer) return false;
  return Boolean(answer.text?.trim()) || Boolean(answer.optionIds?.length) || answer.checked === true;
}

/* ------------------------------ fechas ------------------------------ */

export interface DateParts {
  readonly day: number;
  readonly month: number;
  readonly year: number;
}

/** Acepta AAAA-MM-DD (con o sin hora), DD/MM/AAAA, DD-MM-AAAA, DD.MM.AAAA y DDMMAAAA. Valida la fecha. */
export function parseDate(raw: string): DateParts | null {
  const value = raw.trim();
  let day = 0, month = 0, year = 0;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(value);
  if (match) {
    year = Number(match[1]); month = Number(match[2]); day = Number(match[3]);
  } else if ((match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(value))) {
    day = Number(match[1]); month = Number(match[2]); year = Number(match[3]);
  } else if (/^\d{8}$/.test(value)) {
    day = Number(value.slice(0, 2)); month = Number(value.slice(2, 4)); year = Number(value.slice(4));
  } else {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1900 || year > 2100 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return { day, month, year };
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** «1998-03-15» → «15/03/1998». */
export function formatDate(raw: string): string | null {
  const parts = parseDate(raw);
  return parts ? `${pad(parts.day)}/${pad(parts.month)}/${parts.year}` : null;
}

/** «15/03/1998» → «1998-03-15» (el valor que espera un <input type="date">). */
export function isoDate(raw: string): string | null {
  const parts = parseDate(raw);
  return parts ? `${parts.year}-${pad(parts.month)}-${pad(parts.day)}` : null;
}

/** «15/03/1998» → «15031998» (las 8 casillas de un dígito de Magneto). */
export function dateDigits(raw: string): string | null {
  const parts = parseDate(raw);
  return parts ? `${pad(parts.day)}${pad(parts.month)}${parts.year}` : null;
}

/* ------------------------------ propuestas ------------------------------ */

/** Por encima de este parecido, una respuesta guardada se deja escrita en el panel; por debajo, solo se sugiere. */
export const STRONG_SIMILARITY = 0.5;

/** Dato del perfil para una pregunta, con las mismas reglas que el autocompletado de campos normales. */
export function profileProposal(question: PageQuestion, values: AutofillValues): Proposal | null {
  if (question.sensitive || question.kind === "multi" || question.kind === "checkbox") return null;
  const descriptor: FieldDescriptor = {
    id: question.id,
    kind: "input",
    inputType: question.inputType && question.inputType !== "date" ? question.inputType : "text",
    label: question.label,
    hints: "",
    value: "",
    options: [],
    maxLength: -1,
    size: 0
  };
  const [match] = matchFieldsToValues(values, [descriptor]);
  if (!match) return null;
  if (question.kind === "choice") {
    if (!question.options.length) return null;
    const option = findOption(question.options, match.value);
    return option ? { id: question.id, optionIds: [option.id], source: "profile" } : null;
  }
  if (question.kind === "date") {
    const text = formatDate(match.value);
    return text ? { id: question.id, text, source: "profile" } : null;
  }
  return { id: question.id, text: match.value, source: "profile" };
}

/** Respuesta guardada más parecida a la pregunta, convertida al tipo de la pregunta. */
export function savedProposal(question: PageQuestion, index: readonly AnswerIndexEntry[]): Proposal | null {
  if (question.sensitive || !index.length) return null;
  const best = bestSavedAnswer(tokenize(question.label), index);
  if (!best) return null;
  const text = best.answer.answer_text.trim();
  const base = { id: question.id, source: "saved" as const, similarity: best.score };
  switch (question.kind) {
    case "choice": {
      const option = findOption(question.options, text);
      if (option) return { ...base, optionIds: [option.id] };
      return question.searchable || !question.options.length ? { ...base, text } : null;
    }
    case "multi": {
      const ids = [...new Set(text.split(/\s*[,;\n]\s*/).map(part => findOption(question.options, part)?.id).filter((id): id is string => Boolean(id)))];
      return ids.length ? { ...base, optionIds: ids } : null;
    }
    case "checkbox": {
      const yes = /^(si|sí|yes|true|marcado|acepto)$/i.test(text);
      return yes ? { ...base, checked: true } : null;
    }
    case "date": {
      const formatted = formatDate(text);
      return formatted ? { ...base, text: formatted } : null;
    }
    default:
      return { ...base, text };
  }
}

/**
 * ¿Vale la pena guardar esta respuesta? No si es sensible, si está vacía o si ya está guardada
 * igual (misma pregunta y misma respuesta), para no llenar la cuenta de duplicados.
 */
export function shouldRemember(question: PageQuestion, text: string, saved: readonly SavedAnswer[]): boolean {
  if (question.sensitive || !text.trim()) return false;
  const q = normalizeText(question.label);
  const a = normalizeText(text);
  return !saved.some(entry => normalizeText(entry.question_text) === q && normalizeText(entry.answer_text) === a);
}

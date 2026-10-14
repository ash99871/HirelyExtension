/**
 * Detección heurística de preguntas abiertas. LÓGICA PURA sobre `FieldDescriptor`:
 * no consulta el DOM (el escáner del content script ya lo hizo).
 */
import type { DetectedQuestion, FieldDescriptor } from "./types";

const QUESTION_HINTS: readonly string[] = [
  "why", "tell us", "tell me", "describe", "explain", "what motivates",
  "cover letter", "additional information", "anything else", "why should",
  "por que", "por qué", "cuentanos", "cuéntanos", "cuentame", "cuéntame",
  "explica", "motivacion", "motivación", "experiencia",
  "expectativas", "pretension", "pretensión", "carta de presentacion",
  "carta de presentación", "¿", "?"
];

/** Solo cajas de texto libre: email/tel/url/number, fechas, color... nunca son "preguntas". */
const TEXT_LIKE_TYPES: ReadonlySet<string> = new Set(["", "text", "search"]);

export function detectOpenQuestions(fields: readonly FieldDescriptor[]): DetectedQuestion[] {
  const questions: DetectedQuestion[] = [];
  for (const field of fields) {
    if (field.kind === "select") continue;
    if (field.kind === "input" && !TEXT_LIKE_TYPES.has(field.inputType)) continue;
    if (field.value.trim()) continue;

    const label = field.label || field.hints;
    if (!label) continue;

    const normalized = label.toLocaleLowerCase("es");
    const hasQuestionHint = QUESTION_HINTS.some(hint => normalized.includes(hint));
    const isLongField = field.kind === "textarea" || field.maxLength > 180 || field.size > 70;
    if (!hasQuestionHint && !isLongField) continue;

    questions.push({ fieldId: field.id, question: label, label });
  }
  return questions;
}

export function extractQuestionText(fieldContainer: HTMLElement): string {
  const labelEl = fieldContainer.querySelector(
    'label, .question-text, .form-label, [data-testid*="label"]'
  );

  const rawText = labelEl ? labelEl.textContent || '' : fieldContainer.textContent || '';

  return rawText
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

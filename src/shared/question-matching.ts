/**
 * Coincidencia pregunta ↔ respuestas guardadas. LÓGICA PURA.
 *
 * Coste: O(Q × A) intersecciones de conjuntos pequeños. Para que nunca bloquee el hilo
 * principal, (1) los tokens de cada respuesta se calculan una sola vez en un índice y
 * (2) `attachSuggestionsCooperative` cede el control entre lotes mediante `yieldFn`.
 */
import type { QuestionSuggestion, DetectedQuestion, SavedAnswer } from "./types";
import { jaccard, tokenize } from "./text-similarity";

/** Umbral conservador: las respuestas son sugerencias, no se insertan automáticamente. */
export const SUGGESTION_THRESHOLD = 0.22;
const CATEGORY_WEIGHT = 0.8;

export interface AnswerIndexEntry {
  readonly answer: SavedAnswer;
  readonly questionTokens: ReadonlySet<string>;
  readonly categoryTokens: ReadonlySet<string> | null;
}

export function buildAnswerIndex(answers: readonly SavedAnswer[]): AnswerIndexEntry[] {
  return answers.map(answer => ({
    answer,
    questionTokens: tokenize(answer.question_text),
    categoryTokens: answer.category ? tokenize(answer.category) : null
  }));
}

export function bestSavedAnswer(
  questionTokens: ReadonlySet<string>,
  index: readonly AnswerIndexEntry[]
): { answer: SavedAnswer; score: number } | null {
  let best: { answer: SavedAnswer; score: number } | null = null;
  for (const entry of index) {
    const score = Math.max(
      jaccard(questionTokens, entry.questionTokens),
      entry.categoryTokens ? jaccard(questionTokens, entry.categoryTokens) * CATEGORY_WEIGHT : 0
    );
    if (!best || score > best.score) best = { answer: entry.answer, score };
  }
  return best && best.score >= SUGGESTION_THRESHOLD ? best : null;
}

function withSuggestion(question: DetectedQuestion, best: ReturnType<typeof bestSavedAnswer>): QuestionSuggestion {
  return best ? { ...question, suggestedAnswer: best.answer, similarity: best.score } : question;
}

export function attachSuggestions(questions: readonly DetectedQuestion[], answers: readonly SavedAnswer[]): QuestionSuggestion[] {
  const index = buildAnswerIndex(answers);
  return questions.map(question => withSuggestion(question, bestSavedAnswer(tokenize(question.question), index)));
}

export interface CooperativeOptions {
  /** Cede el hilo (p. ej. `scheduler.yield()` o `setTimeout(0)`). Sin ella, corre de forma síncrona. */
  yieldFn?: () => Promise<void>;
  /** Comparaciones por lote antes de ceder el control. */
  comparisonsPerSlice?: number;
}

/** Igual que `attachSuggestions`, pero troceado para no crear tareas largas en la página. */
export async function attachSuggestionsCooperative(
  questions: readonly DetectedQuestion[],
  answers: readonly SavedAnswer[],
  options: CooperativeOptions = {}
): Promise<QuestionSuggestion[]> {
  const { yieldFn, comparisonsPerSlice = 2000 } = options;
  const index = buildAnswerIndex(answers);
  const cost = Math.max(1, index.length);
  const results: QuestionSuggestion[] = [];
  let budget = comparisonsPerSlice;
  for (const question of questions) {
    if (yieldFn && budget <= 0) {
      await yieldFn();
      budget = comparisonsPerSlice;
    }
    results.push(withSuggestion(question, bestSavedAnswer(tokenize(question.question), index)));
    budget -= cost;
  }
  return results;
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { jaccard, normalizeText, similarity, tokenize } from "../src/shared/text-similarity";
import { attachSuggestions, attachSuggestionsCooperative, buildAnswerIndex, bestSavedAnswer } from "../src/shared/question-matching";
import type { SavedAnswer } from "../src/shared/types";

/** Copia literal del algoritmo ORIGINAL: oráculo para comprobar que el refactor no cambia resultados. */
function legacySimilarity(a: string, b: string): number {
  const STOP = new Set(["que","como","para","por","con","una","uno","las","los","del","de","la","el","en","tu","tus","su","sus","eres","ser","está","esta","the","and","for","you","your","are","what","why","how","our","this","that","with","tell","about","please"]);
  const norm = (v: string) => v.toLocaleLowerCase("es").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  const tok = (v: string) => new Set(norm(v).split(" ").filter(t => t.length > 2 && !STOP.has(t)));
  const left = tok(a), right = tok(b);
  if (!left.size || !right.size) return 0;
  let common = 0;
  for (const t of left) if (right.has(t)) common++;
  return common / (left.size + right.size - common);
}

const SAMPLES = [
  "¿Por qué quieres trabajar con nosotros?", "Why do you want to work here?", "Cuéntanos sobre tu experiencia en ventas",
  "Describe your experience with TypeScript and React", "Pretensión salarial", "Expectativas económicas del cargo",
  "", "   ", "ñandú árbol ÁÉÍ", "Tell us about a time you led a team", "carta de presentación"
];

test("similarity() es idéntica al algoritmo original para todos los pares de muestra", () => {
  for (const a of SAMPLES) for (const b of SAMPLES) {
    assert.equal(similarity(a, b), legacySimilarity(a, b), `par: «${a}» / «${b}»`);
  }
});

test("normalizeText quita acentos y puntuación; tokenize descarta stopwords y tokens cortos", () => {
  assert.equal(normalizeText("¿Cuéntanos  TU experiencia?"), "cuentanos tu experiencia");
  assert.deepEqual([...tokenize("¿Por qué quieres trabajar con nosotros?")].sort(), ["nosotros", "quieres", "trabajar"]);
  assert.equal(jaccard(new Set(), new Set(["a"])), 0);
});

const answer = (id: string, question: string, category: string | null = null): SavedAnswer => ({
  id, user_id: "u", question_text: question, answer_text: `respuesta ${id}`, category, context: null, created_at: "", updated_at: ""
});

const ANSWERS = [
  answer("1", "¿Por qué quieres trabajar con nosotros?", "motivación"),
  answer("2", "Cuéntanos sobre tu experiencia en ventas", "experiencia"),
  answer("3", "Pretensión salarial")
];

test("attachSuggestions elige la mejor respuesta y respeta el umbral", () => {
  const out = attachSuggestions(
    [
      { fieldId: "a", question: "Por qué quieres trabajar con nosotros", label: "x" },
      { fieldId: "b", question: "Color favorito", label: "y" }
    ],
    ANSWERS
  );
  assert.equal(out[0]?.suggestedAnswer?.id, "1");
  assert.ok((out[0]?.similarity ?? 0) >= 0.22);
  assert.equal(out[1]?.suggestedAnswer, undefined, "sin coincidencia suficiente no se sugiere nada");
});

test("la categoría también puede aportar coincidencia (peso 0.8)", () => {
  const index = buildAnswerIndex(ANSWERS);
  const best = bestSavedAnswer(tokenize("experiencia"), index);
  assert.equal(best?.answer.id, "2");
  assert.ok(Math.abs((best?.score ?? 0) - 0.8) < 1e-9);
});

test("la versión cooperativa da EXACTAMENTE el mismo resultado y cede el hilo entre lotes", async () => {
  const questions = Array.from({ length: 60 }, (_, i) => ({
    fieldId: `f${i}`, label: "l", question: SAMPLES[i % SAMPLES.length] ?? ""
  }));
  const many = Array.from({ length: 100 }, (_, i) => answer(String(i), SAMPLES[i % SAMPLES.length] ?? `q${i}`));
  let yields = 0;
  const cooperative = await attachSuggestionsCooperative(questions, many, { comparisonsPerSlice: 500, yieldFn: async () => { yields++; } });
  assert.deepEqual(cooperative, attachSuggestions(questions, many));
  assert.ok(yields >= 10, `debió ceder el hilo varias veces (cedió ${yields})`);
});

test("rendimiento: 100 preguntas × 100 respuestas se resuelve muy por debajo de un frame", () => {
  const questions = Array.from({ length: 100 }, (_, i) => ({ fieldId: `f${i}`, label: "l", question: `${SAMPLES[i % SAMPLES.length]} ${i}` }));
  const many = Array.from({ length: 100 }, (_, i) => answer(String(i), `${SAMPLES[i % SAMPLES.length]} ${i}`));
  const start = performance.now();
  attachSuggestions(questions, many);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 100, `tardó ${elapsed.toFixed(1)} ms`);
  console.log(`  ↳ 100×100 comparaciones: ${elapsed.toFixed(1)} ms`);
});

/**
 * Datos complementarios de Magneto: el modal que aparece tras «Información personal»
 * («Completa los siguientes datos para terminar tu aplicación a la vacante»).
 *
 * LÓGICA PURA: reconoce cada control por el texto que lo rodea y decide qué valor del perfil
 * le corresponde. No toca el DOM (eso vive en src/content/complementary-form.ts).
 *
 * La discapacidad NUNCA se rellena: es un dato sensible que responde siempre la persona.
 */
import { normalizeText, tokenize } from "./text-similarity";
import type { JsonRecord } from "./types";

/** Controles de texto que se rellenan escribiendo o eligiendo de una lista. */
export type ComplementaryKey = "sector" | "job_title" | "education_level" | "salary";

/** Frase del título del modal, normalizada. */
export const MODAL_TITLE_PHRASE = normalizeText("Completa los siguientes datos");

export interface TextHint {
  /** Texto normalizado con normalizeText. */
  readonly text: string;
  /** 0 = atributos del propio control; n = texto de un ancestro a n niveles. */
  readonly depth: number;
}

interface RecognitionRule {
  readonly key: ComplementaryKey;
  readonly recognize: readonly string[];
  /** Si el bloque propio del control contiene alguno de estos términos, NO es este campo. */
  readonly exclude: readonly string[];
}

const RULE_SOURCES: readonly { readonly key: ComplementaryKey; readonly recognize: readonly string[]; readonly exclude: readonly string[] }[] = [
  { key: "sector", recognize: ["sectores laborales", "sector laboral", "sector o sectores"], exclude: [] },
  { key: "job_title", recognize: ["cargo en el que quieres", "agrega un cargo", "cargo oficio o profesion"], exclude: [] },
  { key: "education_level", recognize: ["nivel de estudios"], exclude: [] },
  // El monto de salario comparte fila con «Moneda» y «Frecuencia de pago»: se excluyen esos bloques.
  { key: "salary", recognize: ["salario minimo", "salary"], exclude: ["moneda", "frecuencia de pago"] }
];

const RULES: readonly RecognitionRule[] = RULE_SOURCES.map(rule => ({
  key: rule.key,
  recognize: rule.recognize.map(normalizeText),
  exclude: rule.exclude.map(normalizeText)
}));

/**
 * Devuelve qué campo es un control según sus pistas (las más cercanas al control ganan)
 * y su bloque propio (el contenedor que solo incluye ese control).
 */
export function recognizeComplementaryField(hints: readonly TextHint[], ownBlockText: string): ComplementaryKey | null {
  let best: { key: ComplementaryKey; depth: number } | null = null;
  for (const rule of RULES) {
    if (rule.exclude.some(term => ownBlockText.includes(term))) continue;
    let depth = Number.POSITIVE_INFINITY;
    for (const hint of hints) {
      if (rule.recognize.some(term => hint.text.includes(term))) depth = Math.min(depth, hint.depth);
    }
    if (Number.isFinite(depth) && (!best || depth < best.depth)) best = { key: rule.key, depth };
  }
  return best?.key ?? null;
}

/** 2 = el texto es exactamente la opción; 1 = empieza por ella; 0 = no coincide. */
export function optionMatchScore(optionText: string, wanted: string): 0 | 1 | 2 {
  const text = normalizeText(optionText);
  const target = normalizeText(wanted);
  if (!text || !target) return 0;
  if (text === target) return 2;
  return text.startsWith(target) ? 1 : 0;
}

/** Valores del perfil que usa el modal. Ya normalizados: el DOM solo los escribe o los busca. */
export interface ComplementaryValues {
  readonly sector: string;
  readonly jobTitle: string;
  readonly educationLevel: string;
  /** Solo dígitos, p. ej. "2000000". */
  readonly salary: string;
  /** Textos de las opciones a marcar, p. ej. ["Remoto", "Tiempo completo"]. */
  readonly workPreferences: readonly string[];
}

/** Columnas booleanas de `profiles` que se convierten en una opción del modal cuando son verdaderas. */
const FLAG_OPTIONS: readonly { readonly column: string; readonly option: string }[] = [
  { column: "willing_to_travel", option: "Disponible para viajar" },
  { column: "willing_to_relocate", option: "Disponible para cambio de domicilio" }
];

function readText(record: JsonRecord, key: string): string {
  const raw = record[key];
  if (typeof raw !== "string" && typeof raw !== "number") return "";
  return String(raw).trim();
}

/**
 * Opciones de Magneto que también existen como valor de una lista desplegable de Hirely.
 * Solo estos valores se envían: cualquier otro (p. ej. «Presencial») se ignora en vez de
 * marcar una opción equivocada.
 */
const MODAL_OPTIONS: ReadonlyMap<string, string> = new Map(
  ["Remoto", "Híbrido", "Tiempo completo", "Medio tiempo", "Por horas"].map(option => [normalizeText(option), option])
);

/** Valor de un desplegable de Hirely → texto de la opción del modal, o "" si Magneto no la tiene. */
function modalOption(value: string): string {
  return MODAL_OPTIONS.get(normalizeText(value)) ?? "";
}

/**
 * Monto como dígitos. Magneto pone los puntos de miles por sí solo, así que solo se envían dígitos.
 * «2.000.000» y «2000000» → 2000000. «2000000.00» (decimales con ceros) → 2000000, no 200000000.
 */
export function moneyToDigits(text: string): string {
  const compact = text.trim().replace(/\s/g, "");
  const decimal = /^(\d+)[.,]\d{1,2}$/.exec(compact);
  return decimal?.[1] ?? compact.replace(/\D/g, "");
}

/** Salario como dígitos: admite número (2000000) o texto. */
function salaryDigits(profile: JsonRecord): string {
  const raw = profile["salary_expectation"];
  if (typeof raw === "number" && Number.isFinite(raw)) return String(Math.round(raw));
  return moneyToDigits(readText(profile, "salary_expectation"));
}

/**
 * Jornada en texto libre de Hirely («Lunes a viernes, jornada diurna») → opciones de botón de Magneto.
 * Solo se marca lo que el texto dice con claridad; «Inmediata» no produce ninguna opción.
 */
const SCHEDULE_RULES: readonly { readonly pattern: RegExp; readonly option: string }[] = [
  { pattern: /tiempo completo/, option: "Tiempo completo" },
  { pattern: /medio tiempo/, option: "Medio tiempo" },
  { pattern: /por horas/, option: "Por horas" },
  { pattern: /diurn|manana/, option: "Jornada diurna" },
  { pattern: /nocturn|noche/, option: "Jornada nocturna" },
  { pattern: /fines? de semana/, option: "Fines de semana" }
];

export function scheduleOptions(text: string): string[] {
  const normalized = normalizeText(text);
  return SCHEDULE_RULES.filter(rule => rule.pattern.test(normalized)).map(rule => rule.option);
}

/** Mínimo de palabras en común para elegir por aproximación una opción de lista cerrada. */
export const APPROX_MIN_COVERAGE = 0.6;

/**
 * Qué parte de las palabras de `wanted` aparece en la opción (0–1).
 * «Tecnología» dentro de «Tecnología, informática y telecomunicaciones» → 1.
 */
export function optionCoverageScore(optionText: string, wanted: string): number {
  const target = tokenize(wanted);
  if (!target.size) return 0;
  const option = tokenize(optionText);
  let common = 0;
  for (const token of target) if (option.has(token)) common++;
  return common / target.size;
}

/** Tipo de estudio que reconoce la extensión, de menor a mayor nivel. */
export type EducationBand = "primaria" | "bachiller" | "tecnico" | "tecnologo" | "profesional" | "posgrado";

const BAND_RANK: Readonly<Record<EducationBand, number>> = {
  primaria: 0, bachiller: 1, tecnico: 2, tecnologo: 3, profesional: 4, posgrado: 5
};

/**
 * Texto de la opción en el desplegable «Último nivel de estudios» de Magneto.
 * «Básica primaria» y «Especialización/Maestría» vienen de la especificación; el resto debe
 * confirmarse con la lista real de Magneto (si no coincide, el panel lo marca para revisar).
 */
export const MAGNETO_LEVEL_LABEL: Readonly<Record<EducationBand, string>> = {
  primaria: "Básica primaria",
  bachiller: "Bachiller",
  tecnico: "Técnico",
  tecnologo: "Tecnólogo",
  profesional: "Profesional",
  posgrado: "Especialización/Maestría"
};

/**
 * El tipo de título se decide por cómo EMPIEZA el texto: «Tecnólogo/a en…», «Técnico/a en…»,
 * «Técnico profesional en…», «Tecnología en…», «Bachiller…». Lo que viene después de «en» no cambia
 * la clasificación: «Ingeniero en tecnología de alimentos» sigue siendo profesional.
 */
const TECNOLOGO_HEAD = /^(tecnolog[oa]|tecnologia)(\s+(en|de)\b|$)/;
const TECNICO_HEAD = /^tecnic[oa](\s+(en|de|profesional)\b|$)/;
const BACHILLER_HEAD = /^bachiller/;
/** Posgrado con su nombre genérico en cualquier parte: «Abogado con especialización en derecho penal», «MBA en finanzas». */
const POSGRADO_ANY = /\b(especializ\w*|especialista\w*|maestr\w*|magister\w*|master|mba|phd|doctorad\w*|posgrad\w*|residencia\w*|subespecializ\w*)\b/;
/**
 * Especialidades que se estudian como posgrado y se nombran por su área: «Cardiología», «Cirugía general»,
 * «Medicina interna», «Cuidados intensivos». Se revisan DESPUÉS de tecnólogo, técnico y bachiller, para que
 * «Tecnólogo en radiología» no se vuelva posgrado.
 */
const ESPECIALIDAD_MEDICA = new RegExp("\\b(" + [
  "cardiolog\\w*", "pediatr\\w*", "ginecolog\\w*", "obstetric\\w*", "cirugia\\s+\\w+", "ortoped\\w*",
  "traumatolog\\w*", "anestesiolog\\w*", "dermatolog\\w*", "psiquiatr\\w*", "neurolog\\w*", "oncolog\\w*",
  "radiolog\\w*", "medicina\\s+(interna|familiar|de urgencias|critica|nuclear|del deporte|intensiva)",
  "urgencias", "cuidados intensivos", "nefrolog\\w*", "gastroenterolog\\w*", "endocrinolog\\w*",
  "neumolog\\w*", "reumatolog\\w*", "hematolog\\w*", "infectolog\\w*", "geriatr\\w*", "oftalmolog\\w*",
  "otorrinolaringolog\\w*", "urolog\\w*", "patolog\\w*", "epidemiolog\\w*", "salud ocupacional"
].join("|") + ")\\b");

/** Clasifica un texto de estudio. Sin reglas que coincidan, es profesional (p. ej. «Abogado», «Ingeniería industrial»). */
export function educationBand(text: string): EducationBand {
  const t = normalizeText(text);
  if (POSGRADO_ANY.test(t)) return "posgrado";
  if (TECNOLOGO_HEAD.test(t)) return "tecnologo";
  if (TECNICO_HEAD.test(t)) return "tecnico";
  if (BACHILLER_HEAD.test(t)) return "bachiller";
  if (ESPECIALIDAD_MEDICA.test(t)) return "posgrado";
  if (/\bprimaria\b/.test(t)) return "primaria";
  return "profesional";
}

/**
 * Nivel de estudios para el desplegable de Magneto. Cada campo del registro (nivel, título, programa)
 * se clasifica por separado; se conserva el tipo más alto de todos.
 */
export function educationLevelLabel(rows: readonly JsonRecord[]): string {
  let best: EducationBand | null = null;
  for (const row of rows) {
    for (const key of ["level", "degree", "program"]) {
      const text = readText(row, key);
      if (!text) continue;
      const band = educationBand(text);
      if (best === null || BAND_RANK[band] > BAND_RANK[best]) best = band;
    }
  }
  return best ? MAGNETO_LEVEL_LABEL[best] : "";
}

/**
 * Traduce el perfil de Hirely a los valores del modal.
 * - Desplegables: work_modality (Remoto/Híbrido/Presencial).
 * - Jornada: work_schedule y schedule_availability (texto libre, se interpreta por palabras clave).
 * - Booleanos: willing_to_travel y willing_to_relocate.
 * - Texto: desired_area, desired_position y salary_expectation (número).
 * - education.level: nivel de estudios.
 */
export function resolveComplementaryValues(profile: JsonRecord, education: readonly JsonRecord[] = []): ComplementaryValues {
  const preferences = [
    modalOption(readText(profile, "work_modality")),
    ...FLAG_OPTIONS.filter(flag => profile[flag.column] === true).map(flag => flag.option),
    ...scheduleOptions(readText(profile, "work_schedule")),
    ...scheduleOptions(readText(profile, "schedule_availability"))
  ].filter(Boolean);
  return {
    sector: readText(profile, "desired_area"),
    jobTitle: readText(profile, "desired_position"),
    educationLevel: educationLevelLabel(education),
    salary: salaryDigits(profile),
    workPreferences: [...new Set(preferences)]
  };
}

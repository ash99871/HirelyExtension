/**
 * Mapeo perfil → campos. LÓGICA PURA: recibe descripciones planas de campos
 * (`FieldDescriptor`) y devuelve instrucciones de llenado (`FieldMatch`).
 * No toca el DOM ni dispara eventos; eso es responsabilidad de src/content/dom-fields.ts.
 */
import type { FieldDescriptor, FieldMatch, FieldOption, JsonRecord } from "./types";
import { normalizeText } from "./text-similarity";

interface FieldDefinition {
  readonly keys: readonly string[];
  readonly aliases: readonly string[];
}

const FIELD_DEFINITIONS = {
  first_name: { keys: ["first_name", "given_name", "nombre", "nombres"], aliases: ["first name", "given name", "your first name", "nombre", "nombres", "nombre(s)", "forename"] },
  last_name: { keys: ["last_name", "family_name", "surname", "apellido", "apellidos"], aliases: ["last name", "surname", "family name", "apellido", "apellidos", "apellidos(s)"] },
  full_name: { keys: ["full_name", "name", "nombre_completo"], aliases: ["full name", "complete name", "nombre completo", "your name", "name"] },
  email: { keys: ["email", "correo", "email_address"], aliases: ["email", "e-mail", "correo", "correo electronico", "email address"] },
  phone: { keys: ["phone", "phone_number", "mobile", "telefono", "celular"], aliases: ["phone", "phone number", "mobile", "mobile number", "telephone", "teléfono", "telefono", "celular", "whatsapp"] },
  identification_number: { keys: ["identification_number", "identificationNumber", "document_number", "document", "numero_documento", "numero_de_documento", "identification", "cedula", "cédula"], aliases: ["identification number", "identificationnumber", "document number", "numero de documento", "número de documento", "numero documento", "cédula number", "cedula number"] },
  current_city: { keys: ["current_city", "city", "ciudad"], aliases: ["city", "current city", "ciudad", "ciudad actual", "location city"] },
  current_country: { keys: ["current_country", "country", "pais"], aliases: ["country", "current country", "país", "pais", "country of residence"] },
  address: { keys: ["address", "direccion"], aliases: ["address", "street address", "dirección", "direccion", "home address"] },
  linkedin_url: { keys: ["linkedin_url", "linkedin"], aliases: ["linkedin", "linkedin url", "linkedin profile", "linkedin profile url"] },
  portfolio_url: { keys: ["portfolio_url", "portfolio"], aliases: ["portfolio", "portfolio url", "portfolio website", "work samples"] },
  website_url: { keys: ["website_url", "website", "personal_website"], aliases: ["website", "personal website", "personal site", "web site", "sitio web"] },
  career_objective: { keys: ["career_objective", "professional_summary", "headline", "summary"], aliases: ["professional summary", "career objective", "profile summary", "about you", "about me", "resumen profesional", "objetivo profesional", "headline"] },
  birth_date: { keys: ["birth_date", "date_of_birth", "birthdate"], aliases: ["date of birth", "birth date", "birthday", "fecha de nacimiento"] },
  birth_city: { keys: ["birth_city", "city_of_birth"], aliases: ["birth city", "city of birth", "ciudad de nacimiento"] },
  birth_country: { keys: ["birth_country", "country_of_birth"], aliases: ["birth country", "country of birth", "país de nacimiento", "pais de nacimiento"] },
  available_from: { keys: ["available_from", "start_date", "availability"], aliases: ["available from", "start date", "availability date", "when can you start", "fecha de disponibilidad", "fecha de inicio"] },
  contract_type: { keys: ["contract_type", "employment_type"], aliases: ["contract type", "employment type", "tipo de contrato"] }
} as const satisfies Record<string, FieldDefinition>;

export type FieldKey = keyof typeof FIELD_DEFINITIONS;
/** Valores del perfil ya resueltos, solo para las claves que usamos. */
export type AutofillValues = Readonly<Partial<Record<FieldKey, string>>>;

const FIELD_KEYS = Object.keys(FIELD_DEFINITIONS) as FieldKey[];

/** Alias normalizados UNA sola vez al cargar el módulo (antes se normalizaban en cada comparación). */
const COMPILED = FIELD_KEYS.map(key => ({
  key,
  aliases: FIELD_DEFINITIONS[key].aliases.map(normalizeText).filter(Boolean)
}));

const MIN_CONFIDENCE = 0.78;

const EXCLUDED_INPUT_TYPES: ReadonlySet<string> = new Set([
  "file", "image", "reset", "color", "range", "date", "datetime-local", "month", "week", "time"
]);

/**
 * Si la etiqueta habla de OTRA entidad ("Company name", "School name", "Reference email"),
 * no se rellena con los datos personales del usuario.
 */
const NON_SELF_CONTEXT = /\b(?:company|employer|school|university|college|reference|referee|manager|supervisor|emergency|spouse|parent|guardian|empresa|empleador|universidad|colegio|referencia|jefe|emergencia|conyuge|acudiente)\b/;

function valueFor(profile: JsonRecord, keys: readonly string[]): string {
  for (const key of keys) {
    const raw = profile[key];
    // Solo primitivos: String({}) daría "[object Object]" y acabaría escrito en un formulario.
    if (typeof raw !== "string" && typeof raw !== "number") continue;
    const text = String(raw).trim();
    if (text) return text;
  }
  return "";
}

/**
 * Reduce el perfil completo a SOLO los datos que se usan para autocompletar. El resto del
 * perfil (educación, experiencia, etc.) no necesita vivir en la memoria del content script.
 */
export function resolveAutofillValues(profile: JsonRecord): AutofillValues {
  const values: Partial<Record<FieldKey, string>> = {};
  for (const key of FIELD_KEYS) {
    let value = valueFor(profile, FIELD_DEFINITIONS[key].keys);
    if (key === "full_name" && !value) {
      value = `${valueFor(profile, ["first_name"])} ${valueFor(profile, ["last_name"])}`.trim();
    }
    if (value) values[key] = value;
  }
  return values;
}

function splitCamelCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

function scoreText(text: string, aliases: readonly string[]): number {
  let best = 0;
  for (const alias of aliases) {
    if (text === alias) return 1;
    if (text.includes(alias)) best = Math.max(best, alias.length > 5 ? 0.92 : 0.78);
  }
  return best;
}

export function resolveOption(options: readonly FieldOption[], value: string): FieldOption | null {
  const target = normalizeText(value);
  if (!target) return null;
  return options.find(option => option.value !== "" && (normalizeText(option.label) === target || normalizeText(option.value) === target)) ?? null;
}

export function matchFieldsToValues(values: AutofillValues, fields: readonly FieldDescriptor[]): FieldMatch[] {
  const candidates = COMPILED.filter(definition => values[definition.key]);
  if (!candidates.length) return [];

  const matches: FieldMatch[] = [];
  for (const field of fields) {
    if (field.value.trim()) continue; // nunca pisar lo que ya hay escrito
    if (field.kind === "input" && EXCLUDED_INPUT_TYPES.has(field.inputType)) continue;

    // Se evalúa el texto tal cual y con las pistas técnicas separadas por camelCase
    // ("firstName" → "first name") sin romper etiquetas como "LinkedIn".
    const plain = normalizeText(`${field.label} ${field.hints}`);
    if (!plain) continue;
    const split = normalizeText(`${field.label} ${splitCamelCase(field.hints)}`);
    if (NON_SELF_CONTEXT.test(plain) || NON_SELF_CONTEXT.test(split)) continue;

    let best: { key: FieldKey; confidence: number } | null = null;
    for (const definition of candidates) {
      const confidence = Math.max(scoreText(plain, definition.aliases), split === plain ? 0 : scoreText(split, definition.aliases));
      if (confidence > (best?.confidence ?? 0)) best = { key: definition.key, confidence };
    }
    if (!best || best.confidence < MIN_CONFIDENCE) continue;

    const value = values[best.key];
    if (!value) continue;
    let fillValue = value;
    if (field.kind === "select") {
      const option = resolveOption(field.options, value);
      if (!option) continue;
      fillValue = option.value;
    }
    matches.push({ fieldId: field.id, key: best.key, value: fillValue, label: field.label || field.hints, confidence: best.confidence });
  }
  return matches;
}

/** Conveniencia: perfil + campos → instrucciones de llenado. */
export function matchProfileToFields(profile: JsonRecord, fields: readonly FieldDescriptor[]): FieldMatch[] {
  return matchFieldsToValues(resolveAutofillValues(profile), fields);
}

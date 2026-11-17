/**
 * Elegir la opción de una lista de Magneto que mejor corresponde a un dato de Hirely.
 * LÓGICA PURA (sin DOM): ciudades («ciudad + país») y tipo de documento.
 */
import { jaccard, normalizeText, tokenize } from "./text-similarity";

export interface CandidateOption {
  readonly text: string;
}

/** Siglas y variantes habituales del tipo de documento → nombre completo como lo escribe Magneto. */
const DOCUMENT_SYNONYMS: ReadonlyMap<string, string> = new Map([
  ["cc", "cedula de ciudadania"], ["c c", "cedula de ciudadania"], ["cedula", "cedula de ciudadania"],
  ["cedula ciudadania", "cedula de ciudadania"], ["dni", "documento nacional de identidad"],
  ["ce", "cedula de extranjeria"], ["c e", "cedula de extranjeria"],
  ["ti", "tarjeta de identidad"], ["t i", "tarjeta de identidad"],
  ["pas", "pasaporte"], ["passport", "pasaporte"], ["pp", "pasaporte"],
  ["ppt", "permiso por proteccion temporal"], ["pep", "permiso especial de permanencia"],
  ["nit", "nit"], ["rc", "registro civil"]
]);

function expandDocumentType(raw: string): string {
  const key = normalizeText(raw);
  return DOCUMENT_SYNONYMS.get(key) ?? key;
}

/** Posición de la opción más parecida al tipo de documento del perfil, o -1 si ninguna se le parece. */
export function pickDocumentTypeOption(options: readonly CandidateOption[], wanted: string): number {
  const target = expandDocumentType(wanted);
  if (!target) return -1;
  const targetTokens = tokenize(target);
  let best = -1;
  let bestScore = 0;
  options.forEach((option, index) => {
    const text = normalizeText(option.text);
    if (!text) return;
    let score = text === target ? 2 : jaccard(tokenize(text), targetTokens);
    if (text.includes(target) || target.includes(text)) score = Math.max(score, 0.8);
    if (score > bestScore) { best = index; bestScore = score; }
  });
  return bestScore >= 0.5 ? best : -1;
}

export interface CityChoice {
  readonly index: number;
  /** true si el texto de la opción también menciona el país del perfil. */
  readonly countryConfirmed: boolean;
}

/** Palabras completas: «cali» no debe coincidir con «calima». */
function containsPhrase(text: string, phrase: string): boolean {
  return ` ${text} `.includes(` ${phrase} `);
}

/**
 * Opción de la lista de ciudades que coincide con la ciudad y, si se sabe, el país.
 * Exige que la ciudad aparezca completa; el país solo desempata (muchas listas escriben
 * «Medellín, Antioquia» sin país). Entre dos ciudades de igual nombre gana la que menciona el país.
 */
export function pickCityOption(options: readonly CandidateOption[], city: string, country: string): CityChoice | null {
  const wantedCity = normalizeText(city);
  const wantedCountry = normalizeText(country);
  if (!wantedCity) return null;
  let best: { index: number; score: number; countryConfirmed: boolean; length: number } | null = null;
  options.forEach((option, index) => {
    const text = normalizeText(option.text);
    if (!text || !containsPhrase(text, wantedCity)) return;
    const countryConfirmed = wantedCountry !== "" && containsPhrase(text, wantedCountry);
    // Ciudad al inicio («Medellín, Antioquia») pesa más que en medio («Villa de Medellín»).
    let score = text === wantedCity ? 4 : text.startsWith(`${wantedCity} `) ? 3 : 2;
    if (countryConfirmed) score += 1;
    const length = text.length;
    if (!best || score > best.score || (score === best.score && length < best.length)) {
      best = { index, score, countryConfirmed, length };
    }
  });
  return best ? { index: (best as { index: number }).index, countryConfirmed: (best as { countryConfirmed: boolean }).countryConfirmed } : null;
}

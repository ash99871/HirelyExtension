/**
 * Tipos de dominio. Este archivo NO puede referenciar el DOM ni `chrome`:
 * se compila también con `tsconfig.pure.json` (sin lib DOM) para garantizarlo.
 */

export type JsonRecord = Record<string, unknown>;

export interface SupabaseUser {
  id: string;
  email?: string;
}

/** Sesión mínima persistida en chrome.storage.local (sin el objeto `user` completo de GoTrue). */
export interface StoredSession {
  access_token: string;
  refresh_token: string;
  /** Epoch en segundos. */
  expires_at: number;
  user: SupabaseUser;
}

export interface SavedAnswer {
  id: string;
  user_id: string;
  question_text: string;
  answer_text: string;
  category: string | null;
  context: string | null;
  created_at: string;
  updated_at: string;
}

/* ------------------------------------------------------------------ */
/* Abstracción del DOM: descripciones planas de campos de formulario.  */
/* ------------------------------------------------------------------ */

export type FieldKind = "input" | "textarea" | "select";

export interface FieldOption {
  value: string;
  label: string;
}

/**
 * Descripción serializable de un campo. La construye el escáner DOM del content script;
 * la lógica de negocio (mapeo, detección de preguntas) solo ve esto, nunca un Element.
 */
export interface FieldDescriptor {
  /** Id opaco asignado por el escáner; el content script lo usa para volver al elemento real. */
  readonly id: string;
  readonly kind: FieldKind;
  /** `type` del input en minúsculas ("text", "email"...). Vacío para textarea/select. */
  readonly inputType: string;
  /** Texto visible para el usuario: <label>, aria-labelledby, aria-label, placeholder. */
  readonly label: string;
  /** Pistas técnicas: name, id, autocomplete. */
  readonly hints: string;
  /** Valor actual en el momento del escaneo. */
  readonly value: string;
  /** Solo para <select>. */
  readonly options: readonly FieldOption[];
  /** -1 si no hay límite (o no aplica). */
  readonly maxLength: number;
  /** Atributo `size` de los input; 0 si no aplica. */
  readonly size: number;
}

/** Resultado del mapeo perfil → campo. Solo datos; el llenado real ocurre en el content script. */
export interface FieldMatch {
  readonly fieldId: string;
  readonly key: string;
  /** Valor a escribir. Para <select> ya es el `value` de la <option> resuelta. */
  readonly value: string;
  readonly label: string;
  readonly confidence: number;
}

export interface DetectedQuestion {
  readonly fieldId: string;
  readonly question: string;
  readonly label: string;
}

export interface QuestionSuggestion extends DetectedQuestion {
  readonly suggestedAnswer?: SavedAnswer;
  readonly similarity?: number;
}

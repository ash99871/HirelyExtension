/**
 * Modelo de errores único de la extensión. Los servicios lanzan siempre `HirelyError`
 * con un `code` estable y un mensaje en español apto para mostrar al usuario.
 */

export type HirelyErrorCode =
  | "CONFIG"
  | "NETWORK"
  | "AUTH_REQUIRED"
  | "AUTH_EXPIRED"
  | "INVALID_CREDENTIALS"
  | "PERMISSION"
  | "MISSING_TABLE"
  | "VALIDATION"
  | "NOT_FOUND"
  | "SERVER"
  | "EXTENSION_INVALIDATED"
  | "UNKNOWN";

const DEFAULT_MESSAGES: Record<HirelyErrorCode, string> = {
  CONFIG: "La extensión no está configurada. Compílala con HIRELY_SUPABASE_URL y HIRELY_SUPABASE_ANON_KEY.",
  NETWORK: "Sin conexión con Hirely. Revisa tu internet e inténtalo de nuevo.",
  AUTH_REQUIRED: "Inicia sesión en la extensión de Hirely y vuelve a intentarlo.",
  AUTH_EXPIRED: "Tu sesión expiró. Abre la extensión de Hirely e inicia sesión de nuevo.",
  INVALID_CREDENTIALS: "Correo o contraseña incorrectos.",
  PERMISSION: "Tu cuenta no tiene permiso para esta operación.",
  MISSING_TABLE: "Falta la tabla saved_answers. Ejecuta la migración sql/saved_answers.sql en Supabase.",
  VALIDATION: "Revisa los datos: hay campos vacíos o demasiado largos.",
  NOT_FOUND: "No encontramos tu perfil en Hirely. Completa tu perfil en la página web primero.",
  SERVER: "Hirely no está disponible en este momento. Inténtalo de nuevo en unos minutos.",
  EXTENSION_INVALIDATED: "La extensión se actualizó o se reinició. Recarga esta página para seguir usando Hirely.",
  UNKNOWN: "Ocurrió un error inesperado. Inténtalo de nuevo."
};

export class HirelyError extends Error {
  readonly code: HirelyErrorCode;
  /** `true` si repetir la misma petición tiene sentido (fallo transitorio). */
  readonly retryable: boolean;

  constructor(
    code: HirelyErrorCode,
    message: string = DEFAULT_MESSAGES[code],
    options: { cause?: unknown; retryable?: boolean } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HirelyError";
    this.code = code;
    this.retryable = options.retryable ?? (code === "NETWORK" || code === "SERVER");
  }

  static is(error: unknown, ...codes: HirelyErrorCode[]): error is HirelyError {
    return error instanceof HirelyError && (codes.length === 0 || codes.includes(error.code));
  }
}

/** Forma mínima común a PostgrestError, errores de GoTrue y errores de fetch. */
export interface ErrorLike {
  name?: string;
  message?: string;
  code?: string;
  status?: number;
}

const NETWORK_MESSAGE = /failed to fetch|networkerror|network request failed|load failed|err_internet_disconnected|err_network|fetch failed|timed? ?out|aborterror|timeouterror|signal is aborted/i;
const INVALIDATED_MESSAGE = /extension context invalidated|receiving end does not exist|message port closed/i;

function asErrorLike(value: unknown): ErrorLike {
  if (typeof value !== "object" || value === null) return typeof value === "string" ? { message: value } : {};
  const v = value as Record<string, unknown>;
  const out: ErrorLike = {};
  if (typeof v["name"] === "string") out.name = v["name"];
  if (typeof v["message"] === "string") out.message = v["message"];
  if (typeof v["code"] === "string") out.code = v["code"];
  if (typeof v["status"] === "number") out.status = v["status"];
  return out;
}

export function isNetworkFailure(error: unknown): boolean {
  const e = asErrorLike(error);
  if (e.status === 0) return true;
  if (e.name === "AbortError" || e.name === "TimeoutError") return true;
  return NETWORK_MESSAGE.test(e.message ?? "");
}

/** Convierte un error de PostgREST (o equivalente) en un HirelyError tipado. */
export function fromServiceError(error: unknown, status?: number): HirelyError {
  const e = asErrorLike(error);
  const code = e.code ?? "";
  const message = e.message ?? "";
  const http = status ?? e.status;

  if (isNetworkFailure({ ...e, ...(http === undefined ? {} : { status: http }) })) {
    return new HirelyError("NETWORK", undefined, { cause: error });
  }
  if (INVALIDATED_MESSAGE.test(message)) return new HirelyError("EXTENSION_INVALIDATED", undefined, { cause: error });
  if (http === 401 || code === "PGRST301" || code === "PGRST303" || /\bjwt\b/i.test(message)) {
    return new HirelyError("AUTH_EXPIRED", undefined, { cause: error });
  }
  if (code === "PGRST205" || code === "42P01") return new HirelyError("MISSING_TABLE", undefined, { cause: error });
  if (code === "42501" || http === 403) return new HirelyError("PERMISSION", undefined, { cause: error });
  if (code === "PGRST116" || http === 404) return new HirelyError("NOT_FOUND", undefined, { cause: error });
  if (code === "23514" || code === "23502" || code === "22001") return new HirelyError("VALIDATION", undefined, { cause: error });
  if ((http !== undefined && http >= 500) || http === 429) return new HirelyError("SERVER", undefined, { cause: error });
  return new HirelyError("UNKNOWN", undefined, { cause: error });
}

/** Normaliza cualquier valor lanzado a HirelyError (idempotente). */
export function toHirelyError(error: unknown): HirelyError {
  if (error instanceof HirelyError) return error;
  return fromServiceError(error);
}

/** Mensaje apto para el usuario. Nunca incluye datos del perfil ni detalles internos. */
export function userMessage(error: unknown): string {
  return toHirelyError(error).message;
}

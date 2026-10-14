/**
 * Logger con redacción. En producción es un no-op: `__DEV__` es `false` en tiempo de
 * compilación (código muerto eliminado) y además esbuild aplica `drop: ["console"]`.
 *
 * Regla del proyecto: NUNCA registrar valores del perfil, respuestas, correos ni tokens.
 * Registrar solo conteos, códigos de error y estados.
 */

const SENSITIVE_KEY =
  /pass|token|secret|authorization|apikey|api_key|key|email|mail|phone|name|address|birth|linkedin|portfolio|website|answer|question|label|value|profile|summary|objective|session|user/i;

/** Sustituye por "[redacted]" cualquier valor cuya clave parezca sensible. */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 3) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map(item => redact(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redact(inner, depth + 1);
    }
    return out;
  }
  return value;
}

/** Descripción segura de un error: sin `message` (podría contener datos del usuario). */
export function describeError(error: unknown): { name: string; code?: string; status?: number } {
  if (typeof error !== "object" || error === null) return { name: typeof error };
  const e = error as { name?: unknown; code?: unknown; status?: unknown };
  const out: { name: string; code?: string; status?: number } = { name: typeof e.name === "string" ? e.name : "Error" };
  if (typeof e.code === "string") out.code = e.code;
  if (typeof e.status === "number") out.status = e.status;
  return out;
}

type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, message: string, data?: unknown): void {
  if (!__DEV__) return;
  const payload = data === undefined ? [] : [redact(data)];
  switch (level) {
    case "debug": console.debug(`[hirely] ${message}`, ...payload); break;
    case "info": console.info(`[hirely] ${message}`, ...payload); break;
    case "warn": console.warn(`[hirely] ${message}`, ...payload); break;
    case "error": console.error(`[hirely] ${message}`, ...payload); break;
  }
}

export const log = {
  debug: (message: string, data?: unknown) => emit("debug", message, data),
  info: (message: string, data?: unknown) => emit("info", message, data),
  warn: (message: string, data?: unknown) => emit("warn", message, data),
  error: (message: string, data?: unknown) => emit("error", message, data)
};

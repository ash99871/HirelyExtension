import { getConfig } from "./config";
import { HirelyError } from "./errors";
import { fetchWithTimeout } from "./http";
import { jwtExpiresAt } from "./jwt";
import type { StoredSession } from "./types";

/**
 * Cliente mínimo del API REST de Supabase Auth (GoTrue): login con contraseña, refresh y logout.
 * Se usa fetch directo en lugar del SDK completo para no cargar ~200 KB en cada página donde
 * se inyecta el content script, y para tener control total sobre los errores.
 */

interface GoTrueErrorBody {
  code?: number | string;
  error_code?: string;
  msg?: string;
  message?: string;
  error?: string;
  error_description?: string;
}

function authHeaders(): Record<string, string> {
  const { supabaseAnonKey } = getConfig();
  const headers: Record<string, string> = { apikey: supabaseAnonKey, "Content-Type": "application/json" };
  // Las claves anon legadas son JWT y el gateway las acepta como Bearer; las `sb_publishable_` no.
  if (supabaseAnonKey.startsWith("eyJ")) headers["Authorization"] = `Bearer ${supabaseAnonKey}`;
  return headers;
}

async function readErrorBody(response: Response): Promise<GoTrueErrorBody> {
  try {
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null ? (body as GoTrueErrorBody) : {};
  } catch {
    return {};
  }
}

function errorCodeOf(body: GoTrueErrorBody): string {
  return String(body.error_code ?? body.error ?? "").toLowerCase();
}

/** Convierte una respuesta no-OK de GoTrue en un HirelyError. */
async function failFromResponse(response: Response, purpose: "login" | "refresh"): Promise<never> {
  const body = await readErrorBody(response);
  const code = errorCodeOf(body);
  const status = response.status;

  if (status === 429 || code.includes("rate_limit")) {
    throw new HirelyError("SERVER", "Demasiados intentos. Espera un momento antes de volver a intentarlo.", { retryable: false });
  }
  if (status >= 500) throw new HirelyError("SERVER", undefined, { retryable: true });

  if (purpose === "login") {
    if (code === "email_not_confirmed") {
      throw new HirelyError("INVALID_CREDENTIALS", "Confirma tu correo electrónico antes de iniciar sesión.");
    }
    throw new HirelyError("INVALID_CREDENTIALS");
  }
  // Refresh: cualquier 4xx (token no encontrado, ya usado, sesión revocada...) es definitivo.
  throw new HirelyError("AUTH_EXPIRED");
}

function toStoredSession(payload: unknown): StoredSession {
  const p = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
  const access = p["access_token"];
  const refresh = p["refresh_token"];
  const user = (typeof p["user"] === "object" && p["user"] !== null ? p["user"] : {}) as Record<string, unknown>;
  if (typeof access !== "string" || typeof refresh !== "string" || typeof user["id"] !== "string") {
    throw new HirelyError("UNKNOWN", "Supabase devolvió una respuesta de sesión inválida.");
  }
  const expiresIn = typeof p["expires_in"] === "number" ? p["expires_in"] : undefined;
  const expiresAt =
    typeof p["expires_at"] === "number"
      ? p["expires_at"]
      : expiresIn !== undefined
        ? Math.floor(Date.now() / 1000) + expiresIn
        : jwtExpiresAt(access);
  if (expiresAt === null) throw new HirelyError("UNKNOWN", "Supabase devolvió una sesión sin fecha de expiración.");
  return {
    access_token: access,
    refresh_token: refresh,
    expires_at: expiresAt,
    user: typeof user["email"] === "string" ? { id: user["id"], email: user["email"] } : { id: user["id"] }
  };
}

async function tokenGrant(grant: "password" | "refresh_token", body: Record<string, string>, purpose: "login" | "refresh"): Promise<StoredSession> {
  const { supabaseUrl } = getConfig();
  const response = await fetchWithTimeout(`${supabaseUrl}/auth/v1/token?grant_type=${grant}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body)
  });
  if (!response.ok) return failFromResponse(response, purpose);
  return toStoredSession(await response.json().catch(() => null));
}

export function passwordGrant(email: string, password: string): Promise<StoredSession> {
  return tokenGrant("password", { email, password }, "login");
}

export function refreshGrant(refreshToken: string): Promise<StoredSession> {
  return tokenGrant("refresh_token", { refresh_token: refreshToken }, "refresh");
}

/** Invalida la sesión en el servidor. Mejor esfuerzo: el llamador ignora los fallos. */
export async function revokeSession(accessToken: string): Promise<void> {
  const { supabaseUrl } = getConfig();
  await fetchWithTimeout(`${supabaseUrl}/auth/v1/logout?scope=local`, {
    method: "POST",
    headers: { ...authHeaders(), Authorization: `Bearer ${accessToken}` }
  });
}

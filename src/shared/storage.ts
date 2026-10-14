import { HirelyError, toHirelyError } from "./errors";
import { jwtExpiresAt } from "./jwt";
import type { StoredSession } from "./types";

const SESSION_KEY = "hirely.session";

/**
 * Tras recargar/actualizar la extensión, los content scripts ya inyectados quedan huérfanos:
 * `chrome.runtime.id` desaparece y cualquier API lanza "Extension context invalidated".
 * Lo detectamos antes de operar para devolver un error entendible en vez de romper.
 */
export function assertExtensionAlive(): void {
  let alive = false;
  try {
    alive = typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
  } catch {
    alive = false;
  }
  if (!alive) throw new HirelyError("EXTENSION_INVALIDATED");
}

async function withStorage<T>(operation: (area: chrome.storage.LocalStorageArea) => Promise<T>): Promise<T> {
  assertExtensionAlive();
  try {
    return await operation(chrome.storage.local);
  } catch (error) {
    throw toHirelyError(error);
  }
}

/** Valida lo leído del almacenamiento; acepta sesiones guardadas por versiones anteriores. */
export function parseStoredSession(raw: unknown): StoredSession | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const access = r["access_token"];
  const refresh = r["refresh_token"];
  const user = r["user"];
  if (typeof access !== "string" || !access || typeof refresh !== "string" || !refresh) return null;
  if (typeof user !== "object" || user === null) return null;
  const u = user as Record<string, unknown>;
  if (typeof u["id"] !== "string" || !u["id"]) return null;

  const expiresAt = typeof r["expires_at"] === "number" ? r["expires_at"] : jwtExpiresAt(access);
  if (expiresAt === null) return null;

  return {
    access_token: access,
    refresh_token: refresh,
    expires_at: expiresAt,
    user: typeof u["email"] === "string" ? { id: u["id"], email: u["email"] } : { id: u["id"] }
  };
}

export async function saveSession(session: StoredSession): Promise<void> {
  await withStorage(area => area.set({ [SESSION_KEY]: session }));
}

export async function getStoredSession(): Promise<StoredSession | null> {
  const result = await withStorage(area => area.get(SESSION_KEY));
  return parseStoredSession(result[SESSION_KEY]);
}

export async function clearSession(): Promise<void> {
  await withStorage(area => area.remove(SESSION_KEY));
}

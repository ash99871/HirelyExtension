import { passwordGrant, revokeSession } from "./auth-http";
import { toHirelyError } from "./errors";
import { getFreshSession } from "./session";
import { assertExtensionAlive, clearSession, getStoredSession, saveSession } from "./storage";
import type { StoredSession, SupabaseUser } from "./types";

export async function signIn(email: string, password: string): Promise<StoredSession> {
  assertExtensionAlive();
  const session = await passwordGrant(email, password);
  await saveSession(session);
  return session;
}

export async function signOut(): Promise<void> {
  const session = await getStoredSession().catch(() => null);
  // Primero el borrado local (siempre funciona, incluso sin conexión); luego la invalidación
  // remota como mejor esfuerzo.
  await clearSession();
  if (session) await revokeSession(session.access_token).catch(() => undefined);
}

/**
 * Usuario de la sesión guardada, o null si no hay sesión o el servidor la rechazó.
 * Sin conexión devuelve el usuario en caché en vez de cerrar la sesión.
 */
export async function currentUser(): Promise<SupabaseUser | null> {
  try {
    return (await getFreshSession())?.user ?? null;
  } catch (error) {
    const err = toHirelyError(error);
    if (err.code === "AUTH_EXPIRED" || err.code === "AUTH_REQUIRED") return null;
    if (err.code === "NETWORK" || err.code === "SERVER") return (await getStoredSession().catch(() => null))?.user ?? null;
    throw err;
  }
}

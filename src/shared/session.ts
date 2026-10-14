import { refreshGrant } from "./auth-http";
import { HirelyError, toHirelyError } from "./errors";
import { log, describeError } from "./logger";
import { clearSession, getStoredSession, saveSession } from "./storage";
import type { StoredSession } from "./types";

/** Se refresca con antelación para no enviar tokens a punto de caducar. */
const EXPIRY_MARGIN_SECONDS = 60;

export function isExpiring(session: StoredSession, nowSeconds = Date.now() / 1000): boolean {
  return session.expires_at - EXPIRY_MARGIN_SECONDS <= nowSeconds;
}

let inflightRefresh: Promise<StoredSession> | null = null;

/**
 * Devuelve una sesión vigente (o null si no hay sesión guardada).
 *
 * - Refresca solo si hace falta (o con `force`, p. ej. tras un 401).
 * - Peticiones concurrentes comparten UN único refresh: los refresh tokens de Supabase rotan
 *   y son de un solo uso, así que dos refresh en paralelo invalidarían la sesión.
 * - La sesión nueva SIEMPRE se persiste (antes el content script la descartaba y dejaba
 *   caducado el token que guardaba el popup).
 * - Un fallo de red NO borra la sesión; solo un rechazo definitivo del servidor lo hace.
 */
export async function getFreshSession(options: { force?: boolean } = {}): Promise<StoredSession | null> {
  const stored = await getStoredSession();
  if (!stored) return null;
  if (!options.force && !isExpiring(stored)) return stored;
  inflightRefresh ??= refresh(stored).finally(() => {
    inflightRefresh = null;
  });
  return inflightRefresh;
}

async function refresh(stale: StoredSession): Promise<StoredSession> {
  try {
    const fresh = await refreshGrant(stale.refresh_token);
    await saveSession(fresh);
    log.debug("session.refreshed");
    return fresh;
  } catch (error) {
    const err = toHirelyError(error);
    if (err.code !== "AUTH_EXPIRED") throw err; // red, 5xx, extensión invalidada: la sesión se conserva.

    // Otro contexto (popup u otra pestaña) pudo rotar el token justo antes que nosotros.
    const latest = await getStoredSession().catch(() => null);
    if (latest && latest.refresh_token !== stale.refresh_token && !isExpiring(latest)) return latest;

    log.warn("session.rejected", describeError(err));
    await clearSession().catch(() => undefined);
    throw new HirelyError("AUTH_EXPIRED", undefined, { cause: err });
  }
}

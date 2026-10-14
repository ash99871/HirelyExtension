import { PostgrestClient } from "@supabase/postgrest-js";
import { getConfig } from "./config";
import { HirelyError, fromServiceError, toHirelyError, type ErrorLike } from "./errors";
import { REQUEST_TIMEOUT_MS, isOffline, sleep } from "./http";
import { log, describeError } from "./logger";
import { getFreshSession } from "./session";
import { assertExtensionAlive } from "./storage";

/**
 * Solo se importa `@supabase/postgrest-js` (~17 KB minificado) en lugar de `@supabase/supabase-js`
 * (~217 KB: Auth + Realtime + Storage + Functions), que esbuild no puede podar porque
 * `createClient` instancia todos los sub-clientes.
 */

let cached: { token: string; client: PostgrestClient } | undefined;

/** Cliente de datos autenticado con el access token del usuario (RLS decide qué ve). */
export function dataClient(accessToken: string): PostgrestClient {
  if (cached?.token === accessToken) return cached.client;
  const { supabaseUrl, supabaseAnonKey } = getConfig();
  const client = new PostgrestClient(`${supabaseUrl}/rest/v1`, {
    headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${accessToken}` },
    schema: "public",
    timeout: REQUEST_TIMEOUT_MS,
    // Desactivamos el reintento interno (1 s + 2 s + 4 s de espera): la política de reintentos
    // vive aquí, en un único sitio, con esperas cortas y solo para operaciones idempotentes.
    retry: false
  });
  cached = { token: accessToken, client };
  return client;
}

export interface RequestOptions {
  /**
   * `true` para lecturas y borrados (repetirlos no cambia el resultado) → se reintentan ante
   * fallos transitorios. `false` (por defecto) para inserciones: NUNCA se reintentan solas,
   * para no duplicar filas.
   */
  idempotent?: boolean;
  /** Reintentos máximos ante fallos transitorios. Por defecto 2 si es idempotente, 0 si no. */
  retries?: number;
  /** Espera antes de cada reintento, en ms. */
  backoffMs?: readonly number[];
}

interface DbResult<T> {
  data: T | null;
  error: ErrorLike | null;
  status?: number;
}

const DEFAULT_BACKOFF_MS = [400, 1200] as const;

/**
 * Envoltorio estándar de TODAS las peticiones autenticadas a Supabase.
 *
 *  1. Comprueba que el contexto de la extensión siga vivo.
 *  2. Obtiene una sesión vigente (refresca antes de caducar, sin carreras).
 *  3. Ejecuta la operación y normaliza cualquier fallo a `HirelyError`.
 *  4. Token rechazado (401/JWT expired) → un refresh forzado y UN reintento.
 *  5. Red/5xx → reintentos con espera corta, solo si la operación es idempotente.
 *
 * Contrato: solo lanza `HirelyError`; nunca un TypeError crudo. Un fallo de red jamás borra
 * la sesión guardada. Los llamadores pueden mostrar `error.message` tal cual.
 */
export async function authenticatedRequest<T>(
  operation: (db: PostgrestClient) => PromiseLike<DbResult<T>>,
  options: RequestOptions = {}
): Promise<T | null> {
  assertExtensionAlive();
  const maxRetries = options.retries ?? (options.idempotent ? 2 : 0);
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;

  let session = await getFreshSession();
  if (!session) throw new HirelyError("AUTH_REQUIRED");

  let forcedRefresh = false;
  for (let attempt = 0; ; attempt++) {
    try {
      // Con el navegador declarado offline reintentar es inútil: se falla de inmediato.
      if (isOffline()) throw new HirelyError("NETWORK", undefined, { retryable: false });
      const result = await operation(dataClient(session.access_token));
      if (result.error) throw fromServiceError(result.error, result.status);
      return result.data;
    } catch (caught) {
      const error = toHirelyError(caught);
      log.debug("request.failed", { attempt, ...describeError(error) });

      if (error.code === "AUTH_EXPIRED" && !forcedRefresh) {
        forcedRefresh = true;
        const fresh = await getFreshSession({ force: true });
        if (!fresh) throw new HirelyError("AUTH_REQUIRED");
        session = fresh;
        attempt--; // el refresh forzado no consume un reintento de red
        continue;
      }
      if (error.retryable && attempt < maxRetries) {
        await sleep(backoff[Math.min(attempt, backoff.length - 1)] ?? 0);
        continue;
      }
      throw error;
    }
  }
}

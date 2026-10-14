import { HirelyError } from "./errors";

export interface HirelyConfig {
  readonly supabaseUrl: string;
  readonly supabaseAnonKey: string;
}

/**
 * Los valores se inyectan en tiempo de compilación (esbuild `define`) desde `.env` o desde
 * variables de entorno. Así la configuración llega tanto al popup COMO al content script
 * (este último no puede leer un `config.js` cargado por popup.html).
 * Solo se admite la clave pública (anon/publishable); el build rechaza service_role.
 */
export function getConfig(): HirelyConfig {
  const supabaseUrl = __SUPABASE_URL__;
  const supabaseAnonKey = __SUPABASE_ANON_KEY__;
  if (!supabaseUrl || !supabaseAnonKey) throw new HirelyError("CONFIG");
  return { supabaseUrl: supabaseUrl.replace(/\/+$/, ""), supabaseAnonKey };
}

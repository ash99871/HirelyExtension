// Carga y validación de las variables de entorno del build. Sin dependencias.
import { readFile } from "node:fs/promises";

/** Parser mínimo de .env (KEY=VALUE, comentarios con #, comillas opcionales). */
export function parseDotEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

export function decodeJwtPayload(token) {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Devuelve la lista de problemas de la configuración Supabase. Lista vacía = válida.
 * Regla de oro: solo se admite la clave PÚBLICA. service_role / sb_secret_* abortan el build.
 */
export function validateSupabaseConfig({ url, anonKey }) {
  const errors = [];
  const match = /^https:\/\/([a-z0-9-]+)\.supabase\.co$/.exec(url ?? "");
  if (!url) errors.push("Falta HIRELY_SUPABASE_URL.");
  else if (!match || url.includes("TU-PROYECTO")) errors.push("HIRELY_SUPABASE_URL debe tener la forma https://<ref>.supabase.co (sin barra final ni ruta).");

  if (!anonKey) {
    errors.push("Falta HIRELY_SUPABASE_ANON_KEY.");
  } else if (anonKey.startsWith("PEGA_AQUI")) {
    errors.push("HIRELY_SUPABASE_ANON_KEY todavía es el marcador de ejemplo.");
  } else if (anonKey.startsWith("sb_secret_")) {
    errors.push("HIRELY_SUPABASE_ANON_KEY es una clave SECRETA (sb_secret_). Nunca debe ir en una extensión: usa la publishable/anon key.");
  } else if (anonKey.startsWith("sb_publishable_")) {
    // válida
  } else if (anonKey.split(".").length === 3) {
    const payload = decodeJwtPayload(anonKey);
    if (!payload) errors.push("HIRELY_SUPABASE_ANON_KEY parece un JWT pero no se puede leer.");
    else if (payload.role !== "anon") {
      errors.push(`HIRELY_SUPABASE_ANON_KEY tiene role="${payload.role}". Solo se admite role="anon" (¿pegaste la service_role key?).`);
    } else if (match && typeof payload.ref === "string" && payload.ref !== match[1]) {
      errors.push(`La clave pertenece al proyecto "${payload.ref}" pero la URL es de "${match[1]}".`);
    }
  } else {
    errors.push("HIRELY_SUPABASE_ANON_KEY no tiene un formato reconocible (JWT anon o sb_publishable_...).");
  }
  return errors;
}

/** Variables de proceso > .env. */
export async function resolveBuildEnv({ production, cwd = process.cwd(), env = process.env }) {
  let fromFile = {};
  try {
    fromFile = parseDotEnv(await readFile(`${cwd}/.env`, "utf8"));
  } catch {
    /* .env es opcional */
  }
  const url = (env.HIRELY_SUPABASE_URL ?? fromFile.HIRELY_SUPABASE_URL ?? "").trim();
  const anonKey = (env.HIRELY_SUPABASE_ANON_KEY ?? fromFile.HIRELY_SUPABASE_ANON_KEY ?? "").trim();

  const errors = validateSupabaseConfig({ url, anonKey });
  // Una clave secreta es un error SIEMPRE, también en desarrollo.
  const dangerous = errors.some(e => /SECRETA|role=/.test(e));
  if (errors.length && (production || dangerous)) {
    throw new Error(`Configuración de Supabase inválida:\n  - ${errors.join("\n  - ")}\nCopia .env.example a .env y complétalo.`);
  }
  return { url: errors.length ? "" : url, anonKey: errors.length ? "" : anonKey, warnings: errors };
}

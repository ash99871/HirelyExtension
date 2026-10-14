/**
 * Utilidades JWT solo para decidir CUÁNDO refrescar. No validan nada: la validez real
 * de un token la decide siempre el servidor.
 */

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const parsed: unknown = JSON.parse(atob(base64));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Epoch (segundos) de expiración del JWT, o null si no se puede leer. */
export function jwtExpiresAt(token: string): number | null {
  const exp = decodeJwtPayload(token)?.["exp"];
  return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
}

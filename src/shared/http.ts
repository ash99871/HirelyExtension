import { HirelyError } from "./errors";

export const REQUEST_TIMEOUT_MS = 15_000;

export function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * fetch con tiempo límite y errores normalizados: cualquier fallo de transporte
 * (sin red, DNS, timeout) se convierte en HirelyError("NETWORK"); nunca se propaga un
 * TypeError crudo que pueda romper el content script.
 */
export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  if (isOffline()) throw new HirelyError("NETWORK", undefined, { retryable: false });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    throw new HirelyError("NETWORK", undefined, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

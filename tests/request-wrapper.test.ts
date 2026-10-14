import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installChromeMock, type ChromeMock } from "./helpers/chrome-mock";
import { authenticatedRequest } from "../src/shared/supabase";
import { getFreshSession } from "../src/shared/session";
import { currentUser, signIn, signOut } from "../src/shared/auth-service";
import { getStoredSession, saveSession } from "../src/shared/storage";
import { listSavedAnswers, saveAnswer } from "../src/shared/answers-service";
import { HirelyError, fromServiceError, toHirelyError, userMessage } from "../src/shared/errors";
import type { StoredSession } from "../src/shared/types";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
let handler: Handler;
let chromeMock: ChromeMock;
const calls: { url: string; init: RequestInit }[] = [];

// fetch estable: postgrest-js captura la referencia al construirse, así que se enruta por `handler`.
(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init: RequestInit = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  calls.push({ url, init });
  return handler(url, init);
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const FAST = { backoffMs: [0, 0] as const };
let seq = 0;
const nowS = () => Math.floor(Date.now() / 1000);
const makeSession = (over: Partial<StoredSession> = {}): StoredSession => ({
  access_token: `access-${++seq}`, refresh_token: `refresh-${seq}`, expires_at: nowS() + 3600, user: { id: "user-1", email: "ana@x.co" }, ...over
});
const tokenResponse = (s: StoredSession) => json({ ...s, token_type: "bearer", expires_in: 3600 });

beforeEach(() => {
  chromeMock = installChromeMock();
  calls.length = 0;
  handler = () => json({});
  Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true, writable: true });
});

test("camino feliz: usa el access token del usuario y la apikey pública", async () => {
  await saveSession(makeSession({ access_token: "tok-happy" }));
  handler = () => json([{ id: "1", question_text: "q", answer_text: "a", user_id: "user-1", category: null, context: null, created_at: "", updated_at: "" }]);
  const rows = await listSavedAnswers(5);
  assert.equal(rows.length, 1);
  const headers = new Headers(calls[0]?.init.headers);
  assert.equal(headers.get("authorization"), "Bearer tok-happy");
  assert.equal(headers.get("apikey"), "anon-test-key");
  assert.match(calls[0]?.url ?? "", /^https:\/\/testproj\.supabase\.co\/rest\/v1\/saved_answers\?/);
});

test("sin sesión → AUTH_REQUIRED (no rompe, no hace ninguna petición)", async () => {
  await assert.rejects(() => listSavedAnswers(), (e: unknown) => HirelyError.is(e, "AUTH_REQUIRED"));
  assert.equal(calls.length, 0);
});

test("token a punto de caducar → se refresca ANTES de la petición y la sesión nueva se PERSISTE", async () => {
  const stale = makeSession({ access_token: "old", refresh_token: "r-old", expires_at: nowS() + 10 });
  const fresh = makeSession({ access_token: "new", refresh_token: "r-new" });
  await saveSession(stale);
  handler = url => (url.includes("/auth/v1/token") ? tokenResponse(fresh) : json([]));
  await listSavedAnswers();
  assert.equal(new Headers(calls.at(-1)?.init.headers).get("authorization"), "Bearer new");
  assert.equal((await getStoredSession())?.refresh_token, "r-new", "el refresh token rotado debe guardarse (antes se perdía)");
});

test("401 «JWT expired» del servidor → refresh forzado y UN reintento transparente", async () => {
  await saveSession(makeSession({ access_token: "rejected", refresh_token: "r1" }));
  const fresh = makeSession({ access_token: "accepted", refresh_token: "r2" });
  handler = (url, init) => {
    if (url.includes("/auth/v1/token")) return tokenResponse(fresh);
    const auth = new Headers(init.headers).get("authorization");
    return auth === "Bearer accepted" ? json([]) : json({ code: "PGRST301", message: "JWT expired" }, 401);
  };
  assert.deepEqual(await listSavedAnswers(), []);
  assert.equal(calls.filter(c => c.url.includes("/rest/v1/")).length, 2);
});

test("refresh rechazado por el servidor → AUTH_EXPIRED y se limpia la sesión", async () => {
  await saveSession(makeSession({ expires_at: nowS() - 5 }));
  handler = () => json({ error_code: "refresh_token_already_used", msg: "Invalid Refresh Token: Already Used" }, 400);
  await assert.rejects(() => listSavedAnswers(), (e: unknown) => HirelyError.is(e, "AUTH_EXPIRED"));
  assert.equal(await getStoredSession(), null);
});

test("sin red durante el refresh → NETWORK y la sesión NO se borra", async () => {
  const session = makeSession({ expires_at: nowS() - 5 });
  await saveSession(session);
  handler = () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(() => listSavedAnswers(), (e: unknown) => HirelyError.is(e, "NETWORK"));
  assert.equal((await getStoredSession())?.refresh_token, session.refresh_token);
  assert.equal((await currentUser())?.id, "user-1", "offline: el popup sigue mostrando al usuario en vez de cerrar sesión");
});

test("lecturas idempotentes se reintentan ante fallos de red; reintento exitoso devuelve datos", async () => {
  await saveSession(makeSession());
  let attempts = 0;
  handler = () => { attempts++; if (attempts < 3) throw new TypeError("Failed to fetch"); return json([]); };
  assert.deepEqual(await authenticatedRequest(db => db.from("saved_answers").select("id"), { idempotent: true, ...FAST }), []);
  assert.equal(attempts, 3);
});

test("las inserciones NO se reintentan automáticamente (evita duplicados)", async () => {
  await saveSession(makeSession());
  let attempts = 0;
  handler = () => { attempts++; return json({ message: "boom" }, 503); };
  await assert.rejects(() => saveAnswer({ question_text: "q", answer_text: "a" }), (e: unknown) => HirelyError.is(e, "SERVER"));
  assert.equal(attempts, 1);
});

test("clasificación de errores de PostgREST", () => {
  assert.equal(fromServiceError({ code: "PGRST205", message: "Could not find the table 'public.saved_answers'" }, 404).code, "MISSING_TABLE");
  assert.equal(fromServiceError({ code: "42501", message: "new row violates row-level security policy" }, 403).code, "PERMISSION");
  assert.equal(fromServiceError({ message: "TypeError: Failed to fetch" }, 0).code, "NETWORK");
  assert.equal(fromServiceError({ message: "AbortError: signal is aborted" }).code, "NETWORK");
  assert.equal(fromServiceError({ code: "23514", message: "check constraint" }, 400).code, "VALIDATION");
  assert.equal(fromServiceError({ code: "x", message: "oops" }, 502).code, "SERVER");
  assert.equal(toHirelyError(new Error("Extension context invalidated.")).code, "EXTENSION_INVALIDATED");
  assert.equal(toHirelyError("algo raro").code, "UNKNOWN");
  assert.doesNotMatch(userMessage(new Error("detalle interno con ana@x.co")), /ana@x\.co/, "el mensaje al usuario no filtra el error original");
});

test("extensión recargada (context invalidated) → error controlado, nunca una excepción cruda", async () => {
  await saveSession(makeSession());
  chromeMock.invalidate();
  await assert.rejects(() => listSavedAnswers(), (e: unknown) => HirelyError.is(e, "EXTENSION_INVALIDATED"));
  await assert.rejects(() => getFreshSession(), (e: unknown) => HirelyError.is(e, "EXTENSION_INVALIDATED"));
});

test("offline declarado por el navegador falla rápido sin esperar al timeout", async () => {
  await saveSession(makeSession());
  Object.defineProperty(globalThis, "navigator", { value: { onLine: false }, configurable: true, writable: true });
  const t0 = performance.now();
  await assert.rejects(() => listSavedAnswers(), (e: unknown) => HirelyError.is(e, "NETWORK"));
  assert.ok(performance.now() - t0 < 50);
  assert.equal(calls.length, 0);
});

test("refresh concurrente: 5 peticiones simultáneas comparten UN solo refresh (los tokens rotan)", async () => {
  await saveSession(makeSession({ expires_at: nowS() - 5, refresh_token: "r-shared" }));
  const fresh = makeSession({ access_token: "shared-new", refresh_token: "r-shared-2" });
  let refreshes = 0;
  handler = async url => {
    if (url.includes("/auth/v1/token")) { refreshes++; await new Promise(r => setTimeout(r, 10)); return tokenResponse(fresh); }
    return json([]);
  };
  await Promise.all(Array.from({ length: 5 }, () => listSavedAnswers()));
  assert.equal(refreshes, 1);
});

test("login: guarda solo la sesión mínima; credenciales inválidas → mensaje claro; logout limpia aunque falle la red", async () => {
  const s = makeSession();
  handler = () => json({ ...s, user: { id: "user-1", email: "ana@x.co", phone: "300", identities: [{ big: "object" }] }, token_type: "bearer", expires_in: 3600 });
  await signIn("ana@x.co", "pw");
  const stored = await getStoredSession();
  assert.deepEqual(stored?.user, { id: "user-1", email: "ana@x.co" }, "no se persisten phone/identities");
  assert.match(calls[0]?.url ?? "", /\/auth\/v1\/token\?grant_type=password$/);

  handler = () => json({ error_code: "invalid_credentials", msg: "Invalid login credentials" }, 400);
  await assert.rejects(() => signIn("ana@x.co", "mal"), (e: unknown) => HirelyError.is(e, "INVALID_CREDENTIALS") && userMessage(e) === "Correo o contraseña incorrectos.");

  handler = () => { throw new TypeError("Failed to fetch"); };
  await signOut();
  assert.equal(await getStoredSession(), null);
});

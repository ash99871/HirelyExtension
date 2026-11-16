import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

/**
 * Compila content.ts con las MISMAS opciones de producción (iife, minify, drop console, chrome114)
 * y lo ejecuta en un DOM simulado: la prueba más cercana a Chrome sin Chrome.
 */
async function compileContentScript(): Promise<string> {
  const result = await build({
    entryPoints: ["src/content/content.ts"], bundle: true, write: false, format: "iife", platform: "browser",
    target: ["chrome114"], minify: true, loader: { ".css": "text" }, drop: ["console", "debugger"], logLevel: "silent",
    define: { __DEV__: "false", __HIRELY_ENV__: '"production"', __SUPABASE_URL__: '"https://testproj.supabase.co"', __SUPABASE_ANON_KEY__: '"sb_publishable_test"' }
  });
  return result.outputFiles[0]!.text;
}

const FORM = `
  <label for="fn">Nombre</label><input id="fn">
  <label for="em">Correo electrónico</label><input id="em" type="email">
  <label for="co">País</label><select id="co"><option value="">-</option><option value="CO">Colombia</option></select>
  <input name="company_name" placeholder="Company name">
  <label for="why">¿Por qué quieres trabajar con nosotros?</label><textarea id="why"></textarea>
  <label for="exp">Describe tu experiencia en ventas</label><textarea id="exp"></textarea>`;

interface Harness {
  dom: JSDOM; shadow: () => ShadowRoot; listeners: Array<(m: unknown, s: unknown, r: (x: unknown) => void) => boolean>;
  requests: string[]; store: Map<string, unknown>;
}

function setup(opts: { offline?: boolean; extraHtml?: string } = {}): Harness {
  const dom = new JSDOM(`<!doctype html><body>${FORM}${opts.extraHtml ?? ""}</body>`, { runScripts: "outside-only", url: "https://jobs.example.com/apply", pretendToBeVisual: true });
  const w = dom.window as unknown as Record<string, unknown> & { eval(code: string): unknown; Element: typeof Element };
  let shadow: ShadowRoot | undefined;
  const original = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = function (init: ShadowRootInit) { shadow = original.call(this, init); return shadow; };

  const store = new Map<string, unknown>([["hirely.session", {
    access_token: "tok", refresh_token: "ref", expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: "u1", email: "ana@x.co" }
  }]]);
  const listeners: Harness["listeners"] = [];
  w["chrome"] = {
    runtime: { id: "ext", onMessage: { addListener: (fn: Harness["listeners"][number]) => listeners.push(fn) } },
    storage: { local: {
      get: async (k: string) => (store.has(k) ? { [k]: store.get(k) } : {}),
      set: async (o: Record<string, unknown>) => { for (const [k, v] of Object.entries(o)) store.set(k, v); },
      remove: async (k: string) => { store.delete(k); }
    } }
  };
  // jsdom no trae la API fetch: se reutilizan las de Node.
  Object.assign(w, { Headers, Request, Response, TextEncoder });
  const requests: string[] = [];
  w["fetch"] = async (input: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push(url);
    if (opts.offline) throw new TypeError("Failed to fetch");
    const body = url.includes("/education")
      ? []
      : url.includes("/profiles")
      ? { id: "p1", user_id: "u1", first_name: "Ana", last_name: "Pérez", email: "ana@x.co", current_country: "Colombia", birth_date: "1998-03-15", education: [{ secret: "no debe salir" }] }
      : [{ id: "a1", user_id: "u1", question_text: "¿Por qué quieres trabajar con nosotros?", answer_text: "Porque admiro su misión.", category: "motivación", context: null, created_at: "", updated_at: "" }];
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { dom, shadow: () => shadow!, listeners, requests, store };
}

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!check()) { if (Date.now() - t0 > ms) throw new Error("timeout esperando al asistente"); await new Promise(r => setTimeout(r, 10)); }
}

test("bundle de producción: monta la UI, rellena el formulario y sugiere respuestas guardadas", async () => {
  const code = await compileContentScript();
  const h = setup();
  (h.dom.window as unknown as { eval(c: string): void }).eval(code);
  const doc = h.dom.window.document;

  assert.ok(doc.getElementById("hirely-assistant-root"), "se montó el host del Shadow DOM");
  assert.equal(h.listeners.length, 1);

  // Mensajes de otras extensiones se ignoran.
  let responded = 0;
  h.listeners[0]!({ type: "HIRELY_AUTOFILL" }, { id: "intruso" }, () => responded++);
  assert.equal(responded, 0);
  assert.equal(h.requests.length, 0);

  // El popup envía HIRELY_AUTOFILL → el content script responde de inmediato y trabaja.
  h.listeners[0]!({ type: "HIRELY_AUTOFILL" }, { id: "ext" }, () => responded++);
  assert.equal(responded, 1, "responde al popup (evita «message port closed»)");

  const status = () => h.shadow().querySelector(".status")?.textContent ?? "";
  // Antes de llenar nada, pide autorización mostrando los datos encontrados.
  await waitFor(() => !!h.shadow().querySelector(".authorize"));
  assert.equal((doc.getElementById("fn") as HTMLInputElement).value, "", "nada se llena antes de autorizar");
  assert.equal((doc.getElementById("co") as HTMLSelectElement).value, "");
  assert.deepEqual(consentRows(h), ["Nombre=Ana", "Correo electrónico=ana@x.co", "País=Colombia"], "el select muestra el texto, no «CO»");
  assert.equal(h.shadow().querySelector(".authorize")!.textContent, "Autorizar y llenar (3)");
  h.shadow().querySelector<HTMLButtonElement>(".authorize")!.click();
  await waitFor(() => status().startsWith("Autocompletado"));

  assert.equal((doc.getElementById("fn") as HTMLInputElement).value, "Ana");
  assert.equal((doc.getElementById("em") as HTMLInputElement).value, "ana@x.co");
  assert.equal((doc.getElementById("co") as HTMLSelectElement).value, "CO");
  assert.equal((doc.querySelector("[name=company_name]") as HTMLInputElement).value, "");
  assert.equal(status(), "Autocompletado: 3 campo(s). Preguntas abiertas detectadas: 2.");

  const cards = [...h.shadow().querySelectorAll<HTMLElement>(".card")];
  assert.equal(cards.length, 2);
  assert.equal(cards[0]!.querySelector("textarea")!.value, "Porque admiro su misión.", "sugerencia de la respuesta guardada");
  assert.match(cards[0]!.querySelector(".badge")!.textContent!, /coincidencia aproximada 100%/);
  assert.match(cards[1]!.querySelector(".badge")!.textContent!, /No hay una respuesta guardada/);

  // «Usar respuesta» inserta en el campo real de la página.
  cards[0]!.querySelector<HTMLButtonElement>(".use")!.click();
  assert.equal((doc.getElementById("why") as HTMLTextAreaElement).value, "Porque admiro su misión.");
  assert.match(status(), /Respuesta insertada/);

  // Cerrar el panel descarta el estado.
  h.shadow().querySelector<HTMLButtonElement>(".close")!.click();
  assert.equal(h.shadow().querySelectorAll(".card").length, 0);

  // Solo se consultaron las 2 tablas esperadas, con la URL inyectada en build.
  assert.deepEqual(h.requests.map(u => new URL(u).pathname), ["/rest/v1/profiles", "/rest/v1/saved_answers", "/rest/v1/education"]);
  assert.match(h.requests.find(u => u.includes("/education"))!, /profile_id=eq\.p1/, "estudios filtrados por el perfil propio");
  assert.ok(h.requests.every(u => u.startsWith("https://testproj.supabase.co/")));
});

/** Filas de la lista de autorización como «Etiqueta=valor». */
function consentRows(h: Harness): string[] {
  return [...h.shadow().querySelectorAll<HTMLElement>(".consent-row")].map(row => {
    const label = row.querySelector(".consent-label")!.textContent;
    const value = row.querySelector<HTMLInputElement>(".consent-value")?.value ?? row.querySelector(".consent-fixed")!.textContent;
    return `${label}=${value}`;
  });
}

async function startAndWaitForConsent(extraHtml = ""): Promise<{ h: Harness; doc: Document; status: () => string }> {
  const code = await compileContentScript();
  const h = setup({ extraHtml });
  (h.dom.window as unknown as { eval(c: string): void }).eval(code);
  h.listeners[0]!({ type: "HIRELY_AUTOFILL" }, { id: "ext" }, () => undefined);
  await waitFor(() => !!h.shadow().querySelector(".authorize"));
  return { h, doc: h.dom.window.document, status: () => h.shadow().querySelector(".status")?.textContent ?? "" };
}

test("autorización: solo llena lo marcado y con el valor que la persona corrigió", async () => {
  const { h, doc, status } = await startAndWaitForConsent();
  const rows = [...h.shadow().querySelectorAll<HTMLElement>(".consent-row")];
  // Corrige el nombre y desmarca el correo.
  const name = rows[0]!.querySelector<HTMLInputElement>(".consent-value")!;
  name.value = "Ana María";
  const emailCheck = rows[1]!.querySelector<HTMLInputElement>(".consent-check")!;
  emailCheck.click();
  assert.equal(emailCheck.checked, false);
  assert.equal(h.shadow().querySelector(".authorize")!.textContent, "Autorizar y llenar (2)");
  assert.equal(rows[2]!.querySelector(".consent-value"), null, "un <select> no se edita como texto");

  h.shadow().querySelector<HTMLButtonElement>(".authorize")!.click();
  await waitFor(() => status().startsWith("Autocompletado"));
  assert.equal((doc.getElementById("fn") as HTMLInputElement).value, "Ana María");
  assert.equal((doc.getElementById("em") as HTMLInputElement).value, "", "desmarcado: no se llena");
  assert.equal((doc.getElementById("co") as HTMLSelectElement).value, "CO");
  assert.equal(status(), "Autocompletado: 2 campo(s). Preguntas abiertas detectadas: 2.");
});

test("autorización: «Quitar todos» deja el botón deshabilitado; «Cancelar» no llena nada y sigue sugiriendo respuestas", async () => {
  const { h, doc, status } = await startAndWaitForConsent();
  const toggle = h.shadow().querySelector<HTMLButtonElement>(".toggle-all")!;
  assert.equal(toggle.textContent, "Quitar todos");
  toggle.click();
  assert.equal(h.shadow().querySelector<HTMLButtonElement>(".authorize")!.disabled, true);
  toggle.click();
  assert.equal(h.shadow().querySelector<HTMLButtonElement>(".authorize")!.disabled, false);

  h.shadow().querySelector<HTMLButtonElement>(".cancel")!.click();
  await waitFor(() => status().startsWith("No se llenó"));
  assert.equal(status(), "No se llenó ningún campo. Preguntas abiertas detectadas: 2.");
  for (const id of ["fn", "em", "co"]) assert.equal((doc.getElementById(id) as HTMLInputElement).value, "", `${id} sin llenar`);
  assert.equal(h.shadow().querySelectorAll(".card").length, 2, "las preguntas abiertas siguen disponibles");
});

test("autorización: cerrar el panel mientras pregunta equivale a no autorizar", async () => {
  const { h, doc } = await startAndWaitForConsent();
  h.shadow().querySelector<HTMLButtonElement>(".close")!.click();
  await new Promise(r => setTimeout(r, 50));
  assert.equal((doc.getElementById("fn") as HTMLInputElement).value, "");
  assert.equal(h.shadow().querySelector(".consent"), null);
  // Se puede volver a abrir y vuelve a preguntar.
  h.listeners[0]!({ type: "HIRELY_AUTOFILL" }, { id: "ext" }, () => undefined);
  await waitFor(() => !!h.shadow().querySelector(".authorize"));
});

/** Fecha de nacimiento como la dibuja Magneto: 8 casillas de un dígito (DD MM AAAA). */
const BIRTH_DATE = `<div class="birth"><p>Fecha de nacimiento</p><div>${
  Array.from({ length: 8 }, (_, i) => `<input class="d" data-i="${i}" maxlength="1" inputmode="numeric">`).join("")
}</div></div>`;
const birthDigits = (doc: Document) => [...doc.querySelectorAll<HTMLInputElement>("input.d")].map(input => input.value).join("");

test("autorización: la fecha de nacimiento de Magneto se pregunta y solo se llena si se autoriza", async () => {
  const { h, doc, status } = await startAndWaitForConsent(BIRTH_DATE);
  assert.ok(consentRows(h).includes("Fecha de nacimiento=15/03/1998"), "aparece en la lista como DD/MM/AAAA");
  assert.equal(consentRows(h).filter(row => row.startsWith("Fecha")).length, 1, "las 8 casillas no salen como campos sueltos");
  assert.equal(birthDigits(doc), "", "nada se escribe antes de autorizar");

  h.shadow().querySelector<HTMLButtonElement>(".authorize")!.click();
  await waitFor(() => status().startsWith("Autocompletado"));
  assert.equal(birthDigits(doc), "15031998");
  assert.match(status(), /^Autocompletado: 4 campo\(s\)\./);
});

test("autorización: fecha de nacimiento desmarcada no se llena; corregida se llena con el valor nuevo", async () => {
  {
    const { h, doc, status } = await startAndWaitForConsent(BIRTH_DATE);
    const row = [...h.shadow().querySelectorAll<HTMLElement>(".consent-row")].find(r => r.textContent!.includes("Fecha de nacimiento"))!;
    row.querySelector<HTMLInputElement>(".consent-check")!.click();
    h.shadow().querySelector<HTMLButtonElement>(".authorize")!.click();
    await waitFor(() => status().startsWith("Autocompletado"));
    assert.equal(birthDigits(doc), "", "desmarcada: casillas vacías");
  }
  {
    const { h, doc, status } = await startAndWaitForConsent(BIRTH_DATE);
    const row = [...h.shadow().querySelectorAll<HTMLElement>(".consent-row")].find(r => r.textContent!.includes("Fecha de nacimiento"))!;
    row.querySelector<HTMLInputElement>(".consent-value")!.value = "02/11/1999";
    h.shadow().querySelector<HTMLButtonElement>(".authorize")!.click();
    await waitFor(() => status().startsWith("Autocompletado"));
    assert.equal(birthDigits(doc), "02111999", "usa la fecha corregida");
  }
});

test("bundle de producción: sin internet muestra un mensaje claro, no rompe y conserva la sesión", async () => {
  const code = await compileContentScript();
  const h = setup({ offline: true });
  (h.dom.window as unknown as { eval(c: string): void }).eval(code);
  const errors: unknown[] = [];
  h.dom.window.addEventListener("error", e => errors.push(e.error));
  h.dom.window.addEventListener("unhandledrejection", e => errors.push(e));

  h.listeners[0]!({ type: "HIRELY_AUTOFILL" }, { id: "ext" }, () => undefined);
  const status = () => h.shadow().querySelector(".status")?.textContent ?? "";
  await waitFor(() => /Sin conexión/.test(status()), 6000);

  assert.equal(h.shadow().querySelector(".status")?.getAttribute("data-tone"), "error");
  assert.deepEqual(errors, [], "ninguna excepción escapó al contexto de la página");
  assert.ok(h.store.has("hirely.session"), "un fallo de red no cierra la sesión");
});

test("bundle de producción: sin sesión pide iniciar sesión (sin llamar a la red)", async () => {
  const code = await compileContentScript();
  const h = setup();
  h.store.clear();
  (h.dom.window as unknown as { eval(c: string): void }).eval(code);
  h.listeners[0]!({ type: "HIRELY_AUTOFILL" }, { id: "ext" }, () => undefined);
  const status = () => h.shadow().querySelector(".status")?.textContent ?? "";
  await waitFor(() => /Inicia sesión/.test(status()));
  assert.equal(h.requests.length, 0);
});

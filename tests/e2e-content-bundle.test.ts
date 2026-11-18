import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

/**
 * Compila content.ts con las MISMAS opciones de producción (iife, minify, drop console, chrome114)
 * y lo ejecuta en un DOM simulado: la prueba más cercana a Chrome sin Chrome.
 */
let bundle: Promise<string> | undefined;
function compileContentScript(): Promise<string> {
  bundle ??= build({
    entryPoints: ["src/content/content.ts"], bundle: true, write: false, format: "iife", platform: "browser",
    target: ["chrome114"], minify: true, loader: { ".css": "text" }, drop: ["console", "debugger"], logLevel: "silent",
    define: { __DEV__: "false", __HIRELY_ENV__: '"production"', __SUPABASE_URL__: '"https://testproj.supabase.co"', __SUPABASE_ANON_KEY__: '"sb_publishable_test"' }
  }).then(result => result.outputFiles[0]!.text);
  return bundle;
}

const FORM = `
  <label for="fn">Nombre</label><input id="fn">
  <label for="em">Correo electrónico</label><input id="em" type="email">
  <label for="co">País</label><select id="co"><option value="">-</option><option value="CO">Colombia</option></select>
  <input name="company_name" placeholder="Company name">
  <label for="why">¿Por qué quieres trabajar con nosotros?</label><textarea id="why"></textarea>
  <label for="exp">Describe tu experiencia en ventas</label><textarea id="exp"></textarea>`;

interface Harness {
  dom: JSDOM; doc: Document; shadow: () => ShadowRoot; listeners: Array<(m: unknown, s: unknown, r: (x: unknown) => void) => boolean>;
  requests: string[]; posts: { url: string; body: Record<string, unknown> }[]; store: Map<string, unknown>;
}

function setup(opts: { offline?: boolean; body?: string; extraHtml?: string; profile?: Record<string, unknown> } = {}): Harness {
  const dom = new JSDOM(`<!doctype html><body>${opts.body ?? FORM}${opts.extraHtml ?? ""}</body>`, { runScripts: "outside-only", url: "https://jobs.example.com/apply", pretendToBeVisual: true });
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
  const posts: Harness["posts"] = [];
  w["fetch"] = async (input: unknown, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push(url);
    if (opts.offline) throw new TypeError("Failed to fetch");
    if ((init?.method ?? "GET").toUpperCase() === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      posts.push({ url, body });
      return new Response(JSON.stringify({ id: `n${posts.length}`, user_id: "u1", created_at: "", updated_at: "", ...body }), { status: 201, headers: { "Content-Type": "application/json" } });
    }
    const body = url.includes("/education")
      ? []
      : url.includes("/profiles")
      ? { id: "p1", user_id: "u1", first_name: "Ana", last_name: "Pérez", email: "ana@x.co", current_country: "Colombia", birth_date: "1998-03-15", education: [{ secret: "no debe salir" }], ...opts.profile }
      : [{ id: "a1", user_id: "u1", question_text: "¿Por qué quieres trabajar con nosotros?", answer_text: "Porque admiro su misión.", category: "motivación", context: null, created_at: "", updated_at: "" }];
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { dom, doc: dom.window.document, shadow: () => shadow!, listeners, requests, posts, store };
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!check()) { if (Date.now() - t0 > ms) throw new Error("timeout esperando al asistente"); await new Promise(r => setTimeout(r, 10)); }
}

/** Filas de «Encontramos esta información» como «Etiqueta=valor». */
function consentRows(h: Harness): string[] {
  return [...h.shadow().querySelectorAll<HTMLElement>(".consent-row")].map(row => {
    const label = row.querySelector(".consent-label")!.textContent;
    const value = row.querySelector<HTMLInputElement>(".consent-value")?.value ?? row.querySelector(".consent-fixed")!.textContent;
    return `${label}=${value}`;
  });
}

/** Preguntas de «Necesitamos tu respuesta», por etiqueta. */
function askLabels(h: Harness): string[] {
  return [...h.shadow().querySelectorAll(".ask-row .ask-label")].map(el => el.textContent ?? "");
}

function askRow(h: Harness, label: string): HTMLElement {
  const row = [...h.shadow().querySelectorAll<HTMLElement>(".ask-row")].find(r => r.querySelector(".ask-label")!.textContent!.startsWith(label));
  if (!row) throw new Error(`no hay pregunta «${label}»: ${askLabels(h).join(" | ")}`);
  return row;
}

function type(field: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  field.value = text;
  // El evento debe ser del mismo «mundo» que la página simulada (jsdom), no el Event de Node.
  const win = field.ownerDocument.defaultView as unknown as { Event: typeof Event };
  field.dispatchEvent(new win.Event("input"));
}

async function start(opts: Parameters<typeof setup>[0] = {}, prepare?: (h: Harness) => void): Promise<Harness & { status: () => string; done: () => string }> {
  const code = await compileContentScript();
  const h = setup(opts);
  prepare?.(h);
  (h.dom.window as unknown as { eval(c: string): void }).eval(code);
  h.listeners[0]!({ type: "HIRELY_AUTOFILL" }, { id: "ext" }, () => undefined);
  await waitFor(() => !!h.shadow().querySelector(".authorize, .done"), 6000);
  return {
    ...h,
    status: () => h.shadow().querySelector(".status")?.textContent ?? "",
    done: () => h.shadow().querySelector(".done-title")?.textContent ?? ""
  };
}

/* ------------------------------ formulario normal ------------------------------ */

test("bundle de producción: muestra lo encontrado y lo que falta, y solo llena tras autorizar", async () => {
  const code = await compileContentScript();
  const h = setup();
  (h.dom.window as unknown as { eval(c: string): void }).eval(code);
  assert.ok(h.doc.getElementById("hirely-assistant-root"), "se montó el host del Shadow DOM");
  assert.equal(h.listeners.length, 1);

  // Mensajes de otras extensiones se ignoran.
  let responded = 0;
  h.listeners[0]!({ type: "HIRELY_AUTOFILL" }, { id: "intruso" }, () => responded++);
  assert.equal(responded, 0);
  assert.equal(h.requests.length, 0);

  // El popup envía HIRELY_AUTOFILL → el content script responde de inmediato y trabaja.
  h.listeners[0]!({ type: "HIRELY_AUTOFILL" }, { id: "ext" }, () => responded++);
  assert.equal(responded, 1, "responde al popup (evita «message port closed»)");
  await waitFor(() => !!h.shadow().querySelector(".authorize"));

  // Datos del perfil y preguntas que faltan, sin tocar todavía la página.
  assert.deepEqual(consentRows(h), ["Nombre=Ana", "Correo electrónico=ana@x.co", "País=Colombia"], "el select muestra el texto, no «CO»");
  assert.deepEqual(askLabels(h), ["Company name", "¿Por qué quieres trabajar con nosotros?", "Describe tu experiencia en ventas"],
    "lo de OTRA entidad (Company name) no se llena con el perfil: se pregunta");
  const why = askRow(h, "¿Por qué").querySelector("textarea")!;
  assert.equal(why.value, "Porque admiro su misión.", "la respuesta guardada idéntica ya viene escrita");
  assert.equal(h.doc.querySelector<HTMLInputElement>("#fn")!.value, "", "nada se llena antes de autorizar");
  assert.equal(h.shadow().querySelector(".authorize")!.textContent, "Autorizar y llenar (4)");

  h.shadow().querySelector<HTMLButtonElement>(".authorize")!.click();
  await waitFor(() => !!h.shadow().querySelector(".done"));
  const page = (id: string) => (h.doc.getElementById(id) as HTMLInputElement).value;
  assert.equal(page("fn"), "Ana");
  assert.equal(page("em"), "ana@x.co");
  assert.equal(page("co"), "CO");
  assert.equal(page("why"), "Porque admiro su misión.");
  assert.equal((h.doc.querySelector("[name=company_name]") as HTMLInputElement).value, "");

  // Lo que quedó en blanco no se vuelve a pedir: aparece en el resumen.
  assert.equal(h.shadow().querySelector(".done-title")!.textContent, "Todo listo");
  assert.match(h.shadow().querySelector(".done-text")!.textContent!, /Llenamos 4 campos/);
  const details = [...h.shadow().querySelectorAll(".done-details li")].map(li => li.textContent);
  assert.deepEqual(details, ["Sin responder: Company name", "Sin responder: Describe tu experiencia en ventas"]);

  // Solo se consultaron las 3 tablas esperadas y no se guardó nada (la única respuesta ya estaba guardada).
  assert.deepEqual(h.requests.map(u => new URL(u).pathname), ["/rest/v1/profiles", "/rest/v1/saved_answers", "/rest/v1/education"]);
  assert.match(h.requests.find(u => u.includes("/education"))!, /profile_id=eq\.p1/, "estudios filtrados por el perfil propio");
  assert.equal(h.posts.length, 0);

  h.shadow().querySelector<HTMLButtonElement>(".done-close")!.click();
  assert.equal(h.shadow().querySelector<HTMLElement>(".panel")!.hidden, true);
});

test("autorización: corregir y quitar datos, responder en el panel y recordar la respuesta nueva", async () => {
  const h = await start();
  const rows = [...h.shadow().querySelectorAll<HTMLElement>(".consent-row")];
  type(rows[0]!.querySelector<HTMLInputElement>(".consent-value")!, "Ana María");
  rows[1]!.querySelector<HTMLInputElement>(".consent-check")!.click(); // sin correo
  assert.equal(rows[2]!.querySelector(".consent-value"), null, "un <select> no se edita como texto");
  type(askRow(h, "Describe").querySelector("textarea")!, "Cinco años vendiendo software.");
  assert.equal(h.shadow().querySelector(".authorize")!.textContent, "Autorizar y llenar (4)");

  h.shadow().querySelector<HTMLButtonElement>(".authorize")!.click();
  await waitFor(() => !!h.shadow().querySelector(".done"));
  const page = (id: string) => (h.doc.getElementById(id) as HTMLInputElement).value;
  assert.equal(page("fn"), "Ana María");
  assert.equal(page("em"), "", "desmarcado: no se llena ni se vuelve a ofrecer");
  assert.equal(page("exp"), "Cinco años vendiendo software.");
  assert.match(h.shadow().querySelector(".done-text")!.textContent!, /Llenamos 4 campos/);

  // «Recordar» viene marcado: la respuesta nueva se guarda; la que ya existía, no.
  assert.equal(h.posts.length, 1);
  assert.match(h.posts[0]!.url, /\/rest\/v1\/saved_answers/);
  assert.equal(h.posts[0]!.body["question_text"], "Describe tu experiencia en ventas");
  assert.equal(h.posts[0]!.body["answer_text"], "Cinco años vendiendo software.");
});

test("autorización: «Quitar todos» y «Cancelar» no llenan nada", async () => {
  const h = await start();
  const toggle = h.shadow().querySelector<HTMLButtonElement>(".toggle-all")!;
  assert.equal(toggle.textContent, "Quitar todos");
  toggle.click();
  assert.equal(h.shadow().querySelector(".authorize")!.textContent, "Autorizar y llenar (1)", "queda la respuesta ya escrita");
  type(askRow(h, "¿Por qué").querySelector("textarea")!, "");
  assert.equal(h.shadow().querySelector<HTMLButtonElement>(".authorize")!.disabled, true);

  h.shadow().querySelector<HTMLButtonElement>(".cancel")!.click();
  await waitFor(() => h.done() === "No se llenó nada");
  for (const id of ["fn", "em", "co", "why"]) assert.equal((h.doc.getElementById(id) as HTMLInputElement).value, "", `${id} sin llenar`);
});

test("autorización: cerrar el panel mientras pregunta equivale a no autorizar", async () => {
  const h = await start();
  h.shadow().querySelector<HTMLButtonElement>(".close")!.click();
  await new Promise(r => setTimeout(r, 50));
  assert.equal((h.doc.getElementById("fn") as HTMLInputElement).value, "");
  assert.equal(h.shadow().querySelector(".review"), null);
  // Se puede volver a abrir y vuelve a preguntar.
  h.listeners[0]!({ type: "HIRELY_AUTOFILL" }, { id: "ext" }, () => undefined);
  await waitFor(() => !!h.shadow().querySelector(".authorize"));
});

test("página sin campos (p. ej. el perfil antes de abrir el formulario): dice que no encontró nada", async () => {
  const h = await start({ body: "<main><h1>Mi perfil</h1><button>Completar datos</button></main>" });
  assert.equal(h.done(), "No encontramos campos aquí");
  assert.match(h.shadow().querySelector(".done-text")!.textContent!, /Abre el formulario/);
  assert.equal(h.shadow().querySelector(".authorize"), null, "no hay nada que autorizar");
});

/* ------------------------------ fecha de nacimiento (8 casillas) ------------------------------ */

/** Fecha de nacimiento como la dibuja Magneto: 8 casillas de un dígito (DD MM AAAA). */
const BIRTH_DATE = `<div class="birth"><p>Fecha y ciudad de nacimiento</p><div>${
  Array.from({ length: 8 }, (_, i) => `<input class="d" data-i="${i}" maxlength="1" inputmode="numeric">`).join("")
}</div></div>`;
const birthDigits = (doc: Document) => [...doc.querySelectorAll<HTMLInputElement>("input.d")].map(input => input.value).join("");

test("fecha de nacimiento: «Fecha y ciudad de nacimiento» se reconoce, se pregunta y solo se llena si se autoriza", async () => {
  const h = await start({ extraHtml: BIRTH_DATE });
  assert.ok(consentRows(h).includes("Fecha de nacimiento=15/03/1998"), "aparece en la lista como DD/MM/AAAA");
  assert.equal(askLabels(h).length, 3, "las 8 casillas no salen como campos sueltos");
  assert.equal(birthDigits(h.doc), "", "nada se escribe antes de autorizar");

  h.shadow().querySelector<HTMLButtonElement>(".authorize")!.click();
  await waitFor(() => !!h.shadow().querySelector(".done"));
  assert.equal(birthDigits(h.doc), "15031998");
  assert.match(h.shadow().querySelector(".done-text")!.textContent!, /Llenamos 5 campos/);
});

test("fecha de nacimiento: desmarcada no se llena; corregida se llena con el valor nuevo", async () => {
  {
    const h = await start({ extraHtml: BIRTH_DATE });
    const row = [...h.shadow().querySelectorAll<HTMLElement>(".consent-row")].find(r => r.textContent!.includes("Fecha de nacimiento"))!;
    row.querySelector<HTMLInputElement>(".consent-check")!.click();
    h.shadow().querySelector<HTMLButtonElement>(".authorize")!.click();
    await waitFor(() => !!h.shadow().querySelector(".done"));
    assert.equal(birthDigits(h.doc), "", "desmarcada: casillas vacías");
  }
  {
    const h = await start({ extraHtml: BIRTH_DATE });
    const row = [...h.shadow().querySelectorAll<HTMLElement>(".consent-row")].find(r => r.textContent!.includes("Fecha de nacimiento"))!;
    type(row.querySelector<HTMLInputElement>(".consent-value")!, "02/11/1999");
    h.shadow().querySelector<HTMLButtonElement>(".authorize")!.click();
    await waitFor(() => !!h.shadow().querySelector(".done"));
    assert.equal(birthDigits(h.doc), "02111999", "usa la fecha corregida");
  }
});

/* ------------------------------ formulario de Magneto con preguntas ------------------------------ */

const SELECT2 = "mg_select2_input_magneto-ui-select2-input_button_14gdi";
const TOGGLE = "mg_toggle_button_magneto-ui-toggle-button_1g06c";
const TOGGLE_SELECTED = "mg_toggle_button_toggle-button-selected_1g06c";
const select2 = (id: string, name: string) => `
  <div class="select2-input" id="${id}-wrap">
    <div style="display: none;" id="${id}-box"><input id="${id}-input" name="${name}" type="text"><label for="${id}-input">${name}</label></div>
    <button type="button" id="${id}-btn" class="${SELECT2}">${name}</button>
  </div>`;

/** Basado en «Datos requeridos por el Servicio Público de Empleo» de Magneto (leído el 17/11/2026). */
const SPE_FORM = `
<header><input placeholder="Cargo, profesión o palabra clave"><input placeholder="Ciudad o ubicación"></header>
<div class="modal-ui-drawer"><div class="mg_modal_magneto-ui-modal_1ffsw"><form class="ant-form">
  <p>Datos requeridos por el Servicio Público de Empleo</p>
  <h3>Datos personales:</h3>
  <div><p>¿Con cuál género te identificas? (opcional)</p><div>${select2("genero", "Selecciona un género")}</div></div>
  <div><p>¿Cuál es tu orientación sexual? (opcional)</p><div>${select2("orientacion", "Selecciona tu orientación sexual")}</div></div>
  <div><p>Selecciona tu estado civil actual</p><div id="civil">
    ${["Unión libre", "Soltero(a)", "Casado(a)", "Prefiero no decirlo"].map(t => `<button type="button" class="${TOGGLE}">${t}</button>`).join("")}
  </div></div>
  <h3>De tus estudios recientes:</h3>
  <div><p>Título obtenido (profesión)</p><div><input id="titulo" type="text"></div></div>
  <h3>De tu experiencia laboral reciente:</h3>
  <div><p>Control · App de organización personal</p><p>30/09/2026 - 15/11/2026</p>
    <div><p>Cargo equivalente</p><div>${select2("cargo1", "Cargo equivalente")}</div></div></div>
  <div><p>Pewiri Emeralds · Calidad y precios</p><p>31/07/2026 - 31/10/2026</p>
    <div><p>Cargo equivalente</p><div>${select2("cargo2", "Cargo equivalente")}</div></div></div>
  <section><button type="button" id="save">Guardar</button></section>
</form></div></div>`;

/** Comportamiento de Magneto: el desplegable se abre con su botón y se cierra con un clic fuera. */
function wireMagneto(h: Harness): { clicks: Record<string, number> } {
  const doc = h.doc;
  const clicks: Record<string, number> = {};
  const lists: Record<string, string[] | "search"> = {
    genero: ["Femenino", "Masculino", "Prefiero no contestar"],
    orientacion: ["Heterosexual", "Prefiero no contestar"],
    cargo1: "search", cargo2: "search"
  };
  const close = (id: string) => {
    doc.getElementById(`${id}-list`)?.remove();
    doc.getElementById(`${id}-box`)!.style.display = "none";
    doc.getElementById(`${id}-btn`)!.style.display = "";
  };
  const showOptions = (id: string, options: string[]) => {
    doc.getElementById(`${id}-list`)?.remove();
    const list = doc.createElement("div");
    list.id = `${id}-list`;
    for (const text of options) {
      const option = doc.createElement("button");
      option.type = "button";
      option.className = "select2-list__item mg_select2_list_magneto-ui-select2-list_i";
      option.textContent = text;
      option.addEventListener("click", () => { doc.getElementById(`${id}-btn`)!.textContent = text; close(id); });
      list.append(option);
    }
    doc.getElementById(`${id}-wrap`)!.append(list);
  };
  for (const [id, options] of Object.entries(lists)) {
    doc.getElementById(`${id}-btn`)!.addEventListener("click", () => {
      clicks[id] = (clicks[id] ?? 0) + 1;
      doc.getElementById(`${id}-box`)!.style.display = "block";
      doc.getElementById(`${id}-btn`)!.style.display = "none";
      if (options === "search") {
        const input = doc.getElementById(`${id}-input`) as HTMLInputElement;
        input.oninput = () => (input.value.length >= 3 ? showOptions(id, ["Desarrollador de software", "Desarrollador web"]) : undefined);
      } else {
        showOptions(id, options);
      }
    });
  }
  // Clic fuera: se cierran las listas abiertas sin elegir nada.
  doc.addEventListener("mousedown", event => {
    for (const id of Object.keys(lists)) {
      if (!doc.getElementById(`${id}-wrap`)!.contains(event.target as Node)) close(id);
    }
  });
  for (const button of doc.querySelectorAll<HTMLButtonElement>("#civil button")) {
    button.addEventListener("click", () => {
      for (const other of doc.querySelectorAll("#civil button")) other.classList.remove(TOGGLE_SELECTED);
      button.classList.add(TOGGLE_SELECTED);
    });
  }
  doc.getElementById("save")!.addEventListener("click", () => { clicks["save"] = (clicks["save"] ?? 0) + 1; });
  return { clicks };
}

test("Magneto: avisa «Formulario detectado» y pregunta cada campo con sus opciones (sin tocar el buscador del encabezado)", async () => {
  let clicks: Record<string, number> = {};
  const code = await compileContentScript();
  const h = setup({ body: SPE_FORM });
  clicks = wireMagneto(h).clicks;
  (h.dom.window as unknown as { eval(c: string): void }).eval(code);
  await waitFor(() => !h.shadow().querySelector<HTMLElement>(".detected")!.hidden);
  assert.equal(h.shadow().querySelector(".detected")!.textContent, "Formulario detectado · 6 campos");

  h.shadow().querySelector<HTMLButtonElement>(".detected")!.click();
  await waitFor(() => !!h.shadow().querySelector(".authorize"), 8000);
  assert.equal(h.shadow().querySelector<HTMLElement>(".detected")!.hidden, true, "con el panel abierto, el aviso se oculta");
  assert.deepEqual(askLabels(h), [
    "¿Con cuál género te identificas?",
    "¿Cuál es tu orientación sexual?",
    "Selecciona tu estado civil actual",
    "Título obtenido (profesión)",
    "Cargo equivalente · Control · App de organización personal",
    "Cargo equivalente · Pewiri Emeralds · Calidad y precios"
  ], "el buscador del encabezado no se pregunta; las preguntas repetidas llevan su bloque");

  // Opciones leídas abriendo cada lista; las listas quedaron cerradas y nada se eligió.
  const chips = (label: string) => [...askRow(h, label).querySelectorAll(".chip")].map(c => c.textContent);
  assert.deepEqual(chips("¿Con cuál género"), ["Femenino", "Masculino", "Prefiero no contestar"]);
  assert.deepEqual(chips("Selecciona tu estado civil"), ["Unión libre", "Soltero(a)", "Casado(a)", "Prefiero no decirlo"]);
  assert.equal(h.doc.getElementById("genero-btn")!.textContent, "Selecciona un género");
  assert.equal(h.doc.getElementById("genero-list"), null);
  assert.match(askRow(h, "¿Con cuál género").textContent!, /Opcional/);
  assert.match(askRow(h, "¿Cuál es tu orientación").textContent!, /Dato sensible/, "orientación sexual: dato sensible, no se guarda");
  assert.equal(askRow(h, "Cargo equivalente · Control").querySelector("input")!.placeholder, "Escribe y elegimos la opción más parecida");
  assert.equal(clicks["cargo2"] ?? 0, 0, "listas con el mismo nombre se abren una sola vez");

  // Responder en el panel.
  askRow(h, "¿Con cuál género").querySelectorAll<HTMLButtonElement>(".chip")[0]!.click();
  askRow(h, "Selecciona tu estado civil").querySelectorAll<HTMLButtonElement>(".chip")[1]!.click();
  type(askRow(h, "Título obtenido").querySelector("input")!, "Ingeniería de Sistemas");
  type(askRow(h, "Cargo equivalente · Control").querySelector("input")!, "Desarrollador de software");
  h.shadow().querySelector<HTMLButtonElement>(".authorize")!.click();

  // Queda un campo vacío no opcional (el segundo cargo): se vuelve a pedir… no, solo si era obligatorio.
  await waitFor(() => !!h.shadow().querySelector(".done"), 8000);
  assert.equal(h.doc.getElementById("genero-btn")!.textContent, "Femenino");
  assert.ok(h.doc.querySelectorAll("#civil button")[1]!.classList.contains(TOGGLE_SELECTED), "Soltero(a) marcado");
  assert.equal((h.doc.getElementById("titulo") as HTMLInputElement).value, "Ingeniería de Sistemas");
  assert.equal(h.doc.getElementById("cargo1-btn")!.textContent, "Desarrollador de software", "escribió en el buscador y eligió la sugerencia");
  assert.equal((h.doc.querySelector("header input") as HTMLInputElement).value, "", "el buscador del encabezado no se tocó");
  assert.equal(clicks["save"] ?? 0, 0, "nunca pulsa «Guardar»");
  assert.match(h.shadow().querySelector(".done-text")!.textContent!, /Llenamos 4 campos/);

  // Se recuerdan las respuestas nuevas, pero nunca un dato sensible.
  const saved = h.posts.map(p => p.body["question_text"]);
  assert.ok(saved.includes("Título obtenido (profesión)"));
  assert.ok(!saved.some(q => String(q).includes("orientación")));

  // Lo que la persona dejó en blanco no es «un campo nuevo»: no aparece «Hay campos nuevos».
  await new Promise(r => setTimeout(r, 1300));
  assert.equal(h.shadow().querySelector(".rescan"), null);
});

test("Magneto: un campo obligatorio que quedó vacío se vuelve a pedir en «Faltan campos»", async () => {
  const required = SPE_FORM.replace("<p>Título obtenido (profesión)</p>", "<p>Título obtenido (profesión) *</p>");
  const code = await compileContentScript();
  const h = setup({ body: required });
  wireMagneto(h);
  (h.dom.window as unknown as { eval(c: string): void }).eval(code);
  h.listeners[0]!({ type: "HIRELY_AUTOFILL" }, { id: "ext" }, () => undefined);
  await waitFor(() => !!h.shadow().querySelector(".authorize"), 8000);
  assert.match(askRow(h, "Título obtenido").textContent!, /Obligatorio/);

  // Se responde solo el estado civil: el título obligatorio queda vacío.
  askRow(h, "Selecciona tu estado civil").querySelectorAll<HTMLButtonElement>(".chip")[0]!.click();
  h.shadow().querySelector<HTMLButtonElement>(".authorize")!.click();
  await waitFor(() => /Faltan 1 campo/.test(h.shadow().querySelector(".ask .consent-title")?.textContent ?? ""), 8000);
  assert.deepEqual(askLabels(h), ["Título obtenido (profesión)"]);
  assert.equal(h.shadow().querySelector(".cancel")!.textContent, "Terminar");

  type(askRow(h, "Título obtenido").querySelector("input")!, "Ingeniería de Sistemas");
  h.shadow().querySelector<HTMLButtonElement>(".authorize")!.click();
  await waitFor(() => !!h.shadow().querySelector(".done"), 8000);
  assert.equal((h.doc.getElementById("titulo") as HTMLInputElement).value, "Ingeniería de Sistemas");
  assert.equal(h.shadow().querySelector(".done-title")!.textContent, "Todo listo");
});

/* ------------------------------ errores ------------------------------ */

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

/* ------------------------------ paso «Datos complementarios» ------------------------------ */

/** «Completa los siguientes datos…»: Sector (varias opciones, etiquetas «×») y Ciudad (lista con buscador que tarda en llegar). */
const COMPLEMENTARY = `
<div class="modal-ui-drawer"><div class="mg_modal_magneto-ui-modal_1ffsw"><form>
  <ul class="steps"><li id="step1">Información personal</li><li id="step2">Datos Complementarios</li></ul>
  <h3>Completa los siguientes datos para terminar tu aplicación a la vacante</h3>
  <div><h3>Sector o sectores laborales</h3>
    <div class="select2-input" id="sector-wrap"><div style="display:none" id="sector-box"><input id="sector-input" name="Selecciona sectores laborales"></div>
      <button type="button" class="${SELECT2}" id="sector-btn">Selecciona sectores laborales</button></div>
    <div id="chips"></div></div>
  <div><h3>¿Dónde quieres trabajar?</h3>
    <div class="select2-input" id="city-wrap"><div style="display:none" id="city-box"><input id="city-input" name="Ciudad"></div>
      <button type="button" class="${SELECT2}" id="city-btn">Ciudad</button></div></div>
  <button type="button" id="next">Siguiente</button>
</form></div></div>`;

function wireComplementary(h: Harness): Record<string, number> {
  const doc = h.doc;
  const clicks: Record<string, number> = {};
  const byId = (id: string) => doc.getElementById(id)!;
  const close = (id: string) => { doc.getElementById(`${id}-list`)?.remove(); byId(`${id}-box`).style.display = "none"; byId(`${id}-btn`).style.display = ""; };
  const show = (id: string, options: string[], onPick: (t: string) => void) => {
    doc.getElementById(`${id}-list`)?.remove();
    const list = doc.createElement("div");
    list.id = `${id}-list`;
    for (const text of options) {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "select2-list__item mg_select2_list_magneto-ui-select2-list_i";
      b.textContent = text;
      b.addEventListener("click", () => onPick(text));
      list.append(b);
    }
    byId(`${id}-wrap`).append(list);
  };
  byId("sector-btn").addEventListener("click", () => {
    byId("sector-box").style.display = "block"; byId("sector-btn").style.display = "none";
    show("sector", ["Salud", "Tecnología, informática y telecomunicaciones", "Economía, estadística, matemáticas y afines"], text => {
      const chip = doc.createElement("span");
      chip.innerHTML = `<span>${text}</span><button type="button">×</button>`;
      byId("chips").append(chip); // varias opciones: la lista sigue abierta
    });
  });
  byId("city-btn").addEventListener("click", () => {
    byId("city-box").style.display = "block"; byId("city-btn").style.display = "none";
    const input = byId("city-input") as HTMLInputElement;
    input.oninput = () => {
      // Las ciudades llegan de internet: tardan un poco, y primero salen las homónimas de otros países.
      if (input.value.length < 3) return;
      const pick = (text: string) => { byId("city-btn").textContent = text; close("city"); };
      setTimeout(() => show("city", ["Sabaneta, Veracruz de Ignacio de la Llave, México"], pick), 300);
      setTimeout(() => show("city", ["Sabaneta, Veracruz de Ignacio de la Llave, México", "Sabaneta, Antioquia, Colombia"], pick), 1500);
    };
  });
  doc.addEventListener("mousedown", event => {
    for (const id of ["sector", "city"]) if (!byId(`${id}-wrap`).contains(event.target as Node)) close(id);
  });
  byId("next").addEventListener("click", () => { clicks["next"] = (clicks["next"] ?? 0) + 1; });
  for (const id of ["step1", "step2"]) byId(id).addEventListener("click", () => { clicks[id] = (clicks[id] ?? 0) + 1; });
  return clicks;
}

test("datos complementarios: la ciudad se elige en el primer intento y se avisa cuál; un Sector que no existe se pregunta con las opciones reales", async () => {
  const code = await compileContentScript();
  const h = setup({ body: COMPLEMENTARY, profile: { desired_area: "Datos", current_city: "Sabaneta", current_country: "Colombia" } });
  const clicks = wireComplementary(h);
  (h.dom.window as unknown as { eval(c: string): void }).eval(code);
  h.listeners[0]!({ type: "HIRELY_AUTOFILL" }, { id: "ext" }, () => undefined);
  await waitFor(() => !!h.shadow().querySelector(".authorize"), 8000);
  assert.deepEqual(consentRows(h), ["Sector=Datos", "Ciudad=Sabaneta"]);
  h.shadow().querySelector<HTMLButtonElement>(".authorize")!.click();

  // Sector «Datos» no es una opción: se pregunta enseguida con las opciones de Magneto.
  await waitFor(() => /Faltan 1 campo/.test(h.shadow().querySelector(".ask .consent-title")?.textContent ?? ""), 15000);
  const row = askRow(h, "Sector o sectores laborales");
  assert.match(row.querySelector(".ask-note")!.textContent!, /Tu perfil dice «Datos» y Magneto no tiene esa opción/);
  assert.deepEqual([...row.querySelectorAll(".chip")].map(c => c.textContent),
    ["Salud", "Tecnología, informática y telecomunicaciones", "Economía, estadística, matemáticas y afines"]);
  // La ciudad ya quedó en el primer intento, la de Colombia aunque la de México llegue primero.
  assert.equal(clicks["step2"] ?? 0, 0, "«Datos Complementarios» (el título del paso) no es una opción de Sector");
  assert.equal(h.doc.getElementById("city-btn")!.textContent, "Sabaneta, Antioquia, Colombia");

  row.querySelectorAll<HTMLButtonElement>(".chip")[1]!.click();
  h.shadow().querySelector<HTMLButtonElement>(".authorize")!.click();
  await waitFor(() => !!h.shadow().querySelector(".done"), 15000);
  assert.equal(h.doc.getElementById("chips")!.textContent, "Tecnología, informática y telecomunicaciones×");
  assert.equal(h.doc.getElementById("sector-list"), null, "no queda ninguna lista abierta");
  const details = [...h.shadow().querySelectorAll(".done-details li")].map(li => li.textContent);
  assert.ok(details.includes("Ciudad: elegimos «Sabaneta, Antioquia, Colombia». Verifica que sea la correcta."), details.join(" | "));
  assert.equal(clicks["next"] ?? 0, 0, "nunca pulsa «Siguiente»");
});

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installDom } from "./helpers/dom";
import { applyFieldMatches, fillElement, scanFormFields } from "../src/content/dom-fields";
import { matchFieldsToValues, resolveAutofillValues } from "../src/shared/field-mapping";
import { detectOpenQuestions } from "../src/shared/question-detection";
import { mountAssistantUi } from "../src/content/assistant-ui";

const FORM = `
<form>
  <label for="fn">Nombre(s)</label><input id="fn" name="a1">
  <label>Correo electrónico <input type="email" name="mail"></label>
  <input name="company_name" placeholder="Company name">
  <label for="country">País</label>
  <select id="country"><option value="">Selecciona</option><option value="CO">Colombia</option><option value="MX">México</option></select>
  <label for="why">¿Por qué quieres trabajar con nosotros?</label><textarea id="why"></textarea>
  <span id="lbl-ln">Apellido</span><input id="ln" aria-labelledby="lbl-ln">
  <input type="hidden" name="csrf" value="x">
  <input aria-hidden="true" name="email_trap">
  <input disabled name="email_disabled" aria-label="Email">
  <input name="phone" aria-label="Teléfono" value="ya escrito">
  <label><input type="checkbox"> Acepto</label>
</form>`;

beforeEach(() => { installDom(FORM); });

test("el escáner produce descriptores planos: etiquetas, pistas, opciones; ignora ocultos/deshabilitados", async () => {
  const scan = await scanFormFields();
  const byHint = (needle: string) => scan.fields.find(f => f.hints.includes(needle));

  assert.equal(byHint("a1")?.label, "Nombre(s)");
  assert.equal(byHint("mail")?.label, "Correo electrónico", "la etiqueta que envuelve al input no incluye texto de controles");
  assert.equal(scan.fields.find(f => f.hints.includes("ln"))?.label, "Apellido", "resuelve aria-labelledby");
  const select = scan.fields.find(f => f.kind === "select");
  assert.deepEqual(select?.options.map(o => o.value), ["", "CO", "MX"]);
  assert.equal(scan.fields.find(f => f.hints.includes("csrf")), undefined, "hidden fuera");
  assert.equal(scan.fields.find(f => f.hints.includes("email_trap")), undefined, "aria-hidden fuera (honeypot)");
  assert.equal(scan.fields.find(f => f.hints.includes("email_disabled")), undefined, "deshabilitado fuera");
  assert.doesNotThrow(() => structuredClone(scan.fields), "los descriptores son serializables: cero referencias al DOM");
  assert.equal(scan.truncated, false);
});

test("la etiqueta de un <label> que envuelve un <select> no arrastra las opciones", async () => {
  installDom(`<label>Ciudad <select name="c"><option>Medellín</option><option>Bogotá</option></select></label>`);
  const [field] = (await scanFormFields()).fields;
  assert.equal(field?.label, "Ciudad");
});

test("flujo completo: escanear → lógica pura → llenar → detectar preguntas restantes", async () => {
  const scan = await scanFormFields();
  const values = resolveAutofillValues({ first_name: "Ana", last_name: "Pérez", email: "ana@x.co", current_country: "Colombia", phone: "999" });
  const matches = matchFieldsToValues(values, scan.fields);
  const report = applyFieldMatches(matches, scan.elements);

  const doc = document;
  assert.equal((doc.getElementById("fn") as HTMLInputElement).value, "Ana");
  assert.equal((doc.getElementById("ln") as HTMLInputElement).value, "Pérez");
  assert.equal((doc.getElementById("country") as HTMLSelectElement).value, "CO");
  assert.equal((doc.querySelector("[name=mail]") as HTMLInputElement).value, "ana@x.co");
  assert.equal((doc.querySelector("[name=company_name]") as HTMLInputElement).value, "", "«Company name» no recibe el nombre del usuario");
  assert.equal((doc.querySelector("[name=phone]") as HTMLInputElement).value, "ya escrito", "no pisa lo escrito");
  assert.equal(report.filled.size, 4);

  const questions = detectOpenQuestions(scan.fields.filter(f => !report.filled.has(f.id)));
  assert.deepEqual(questions.map(q => q.question), ["¿Por qué quieres trabajar con nosotros?"]);
});

test("fillElement dispara input → change → blur → focusout (burbujeando) para frameworks reactivos", () => {
  const input = document.getElementById("fn") as HTMLInputElement;
  const order: string[] = [];
  const bubbled: string[] = [];
  for (const type of ["input", "change", "blur", "focusout"]) {
    input.addEventListener(type, e => order.push(e.type));
    document.addEventListener(type, e => bubbled.push(e.type)); // fase de burbujeo
  }
  assert.equal(fillElement(input, "Ana"), "filled");
  assert.deepEqual(order, ["input", "change", "blur", "focusout"]);
  assert.deepEqual(bubbled, ["input", "change", "focusout"], "blur no burbuja; focusout sí (React escucha focusout para onBlur)");
});

test("simula React: el setter de instancia (rastreador de valor) se esquiva usando el setter del prototype", () => {
  const input = document.getElementById("fn") as HTMLInputElement;
  const protoValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!;
  let tracked = "";
  let instanceWrites = 0;
  Object.defineProperty(input, "value", {
    configurable: true,
    get() { return protoValue.get!.call(this); },
    set(v: string) { instanceWrites++; tracked = v; protoValue.set!.call(this, v); }
  });

  // Control: asignar directamente SÍ pasaría por el rastreador (así React no vería el cambio).
  input.value = "directo";
  assert.equal(instanceWrites, 1);
  input.value = "";
  instanceWrites = 0;

  assert.equal(fillElement(input, "Ana"), "filled");
  assert.equal(instanceWrites, 0, "no se tocó el rastreador de React");
  assert.equal(tracked, "", "React sigue viendo el valor anterior → el evento input SÍ se interpreta como cambio");
  assert.equal(protoValue.get!.call(input), "Ana");
});

test("fillElement: protege valores del usuario, elementos desconectados, deshabilitados y opciones inexistentes", () => {
  const input = document.getElementById("fn") as HTMLInputElement;
  input.value = "escrito por el usuario";
  assert.equal(fillElement(input, "Ana"), "skipped-has-value");
  assert.equal(input.value, "escrito por el usuario");
  assert.equal(fillElement(input, "Ana", { overwrite: true }), "filled", "acción explícita del usuario sí sustituye");

  const select = document.getElementById("country") as HTMLSelectElement;
  assert.equal(fillElement(select, "PE"), "skipped-no-option");
  assert.equal(select.value, "", "no altera el select si la opción no existe");

  const area = document.getElementById("why") as HTMLTextAreaElement;
  area.disabled = true;
  assert.equal(fillElement(area, "x"), "skipped-disabled");
  area.remove();
  assert.equal(fillElement(area, "x"), "skipped-detached");
});

test("escáner: respeta el límite de campos y cede el hilo en formularios enormes", async () => {
  installDom(Array.from({ length: 700 }, (_, i) => `<label for="i${i}">Campo ${i}</label><input id="i${i}">`).join(""));
  const t0 = performance.now();
  const scan = await scanFormFields();
  assert.equal(scan.fields.length, 400);
  assert.equal(scan.truncated, true);
  const elapsed = performance.now() - t0;
  console.log(`  ↳ 700 campos (400 procesados): ${elapsed.toFixed(0)} ms`);
  assert.ok(elapsed < 2000, `el escaneo no debe ser cuadrático (tardó ${elapsed.toFixed(0)} ms)`);
});

test("Shadow DOM: raíz cerrada, estilos dentro de la sombra, nada del panel en el DOM de la página", () => {
  let shadow: ShadowRoot | undefined;
  const original = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) { shadow = original.call(this, init); return shadow; };
  const events: string[] = [];
  document.addEventListener("keydown", e => events.push(e.type));
  document.addEventListener("click", e => events.push(e.type));

  const ui = mountAssistantUi({ onLaunch() {}, onUseAnswer() {}, onSaveAnswer: async () => true, onClosed() {} });
  Element.prototype.attachShadow = original;

  const host = document.getElementById("hirely-assistant-root")!;
  assert.equal(host.shadowRoot, null, "modo closed: el código de la página no puede inspeccionar el panel");
  assert.ok(shadow, "se creó un shadow root");
  assert.equal(document.querySelector(".panel, .fab"), null, "ni .panel ni .fab existen en el DOM de la página");
  assert.ok(shadow!.querySelector("style") ?? shadow!.adoptedStyleSheets?.length, "los estilos están dentro de la sombra");
  assert.equal(document.querySelectorAll("style").length, 0, "no se inyecta ningún <style> en el documento");

  ui.openPanel();
  ui.renderQuestions([{ id: "q", label: "¿Por qué?", initialAnswer: "porque sí", similarity: 0.5 }]);
  const textarea = shadow!.querySelector("textarea")!;
  textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "h", bubbles: true, composed: true }));
  shadow!.querySelector<HTMLButtonElement>(".use")!.click();
  assert.deepEqual(events, [], "ni teclas ni clics del panel llegan a los manejadores globales del sitio");

  ui.closePanel();
  assert.equal(shadow!.querySelectorAll(".card").length, 0, "al cerrar se descartan las respuestas del DOM");
  ui.destroy();
  assert.equal(document.getElementById("hirely-assistant-root"), null);
});

test("el panel monta de forma idempotente y delega las acciones sin conocer los campos", async () => {
  const calls: string[] = [];
  let shadow: ShadowRoot | undefined;
  const original = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) { shadow = original.call(this, init); return shadow; };
  mountAssistantUi({ onLaunch() {}, onUseAnswer() {}, onSaveAnswer: async () => true, onClosed() {} });
  const ui = mountAssistantUi({
    onLaunch: () => calls.push("launch"),
    onUseAnswer: (id, text) => calls.push(`use:${id}:${text}`),
    onSaveAnswer: async (id, text) => { calls.push(`save:${id}:${text}`); return true; },
    onClosed: () => calls.push("closed")
  });
  Element.prototype.attachShadow = original;
  assert.equal(document.querySelectorAll("#hirely-assistant-root").length, 1, "re-montar no duplica el host");

  shadow!.querySelector<HTMLButtonElement>(".fab")!.click();
  ui.openPanel();
  ui.renderQuestions([{ id: "q1", label: "Pregunta", initialAnswer: "Respuesta" }]);
  shadow!.querySelector<HTMLButtonElement>(".use")!.click();
  const save = shadow!.querySelector<HTMLButtonElement>(".save")!;
  save.click();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(save.textContent, "Guardada ✓");
  ui.closePanel();
  assert.deepEqual(calls, ["launch", "use:q1:Respuesta", "save:q1:Respuesta", "closed"]);
});

test("el contenido del usuario se inserta como texto, nunca como HTML (sin XSS)", () => {
  let shadow: ShadowRoot | undefined;
  const original = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) { shadow = original.call(this, init); return shadow; };
  const ui = mountAssistantUi({ onLaunch() {}, onUseAnswer() {}, onSaveAnswer: async () => true, onClosed() {} });
  Element.prototype.attachShadow = original;
  ui.openPanel();
  ui.renderQuestions([{ id: "x", label: `<img src=x onerror=alert(1)>`, initialAnswer: `<script>alert(1)</script>` }]);
  assert.equal(shadow!.querySelector("img"), null);
  assert.equal(shadow!.querySelector("script"), null);
  assert.equal(shadow!.querySelector(".label")!.textContent, `<img src=x onerror=alert(1)>`);
});

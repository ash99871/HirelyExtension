import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installDom } from "./helpers/dom";
import {
  answerText,
  cleanQuestionLabel,
  dateDigits,
  findOption,
  formatDate,
  isSensitiveQuestion,
  isoDate,
  labelSaysOptional,
  labelSaysRequired,
  looksMultiChoice,
  profileProposal,
  savedProposal,
  shouldRemember,
  type PageQuestion
} from "../src/shared/form-questions";
import { resolveAutofillValues } from "../src/shared/field-mapping";
import { buildAnswerIndex } from "../src/shared/question-matching";
import { applyAnswer, collectQuestions, findFormScope, isHandleFilled } from "../src/content/page-questions";
import type { SavedAnswer } from "../src/shared/types";

/* ------------------------------ lógica pura ------------------------------ */

const question = (over: Partial<PageQuestion>): PageQuestion => ({
  id: "q1", kind: "text", label: "", required: false, optional: false, sensitive: false,
  options: [], searchable: false, inputType: "", ...over
});
const saved = (question_text: string, answer_text: string): SavedAnswer => ({
  id: question_text, user_id: "u", question_text, answer_text, category: null, context: null, created_at: "", updated_at: ""
});

test("etiquetas: se limpian «*» y «(opcional)», y se sabe qué es obligatorio u opcional", () => {
  assert.equal(cleanQuestionLabel("¿Con cuál género te identificas? (opcional)"), "¿Con cuál género te identificas?");
  assert.equal(cleanQuestionLabel("Sector o sectores laborales *"), "Sector o sectores laborales");
  assert.equal(cleanQuestionLabel("Datos personales:"), "Datos personales");
  assert.equal(labelSaysRequired("Cargo *"), true);
  assert.equal(labelSaysRequired("Género (opcional)"), false);
  assert.equal(labelSaysOptional("Género (opcional)"), true);
  assert.equal(labelSaysRequired("Selecciona tu estado civil actual"), false, "sin marca: no se sabe");
});

test("datos sensibles: se preguntan, pero nunca se proponen ni se guardan", () => {
  for (const label of ["¿Tienes alguna discapacidad?", "¿Cuál es tu orientación sexual?", "Grupo étnico", "¿Perteneces a algún grupo poblacional?", "Religión"]) {
    assert.equal(isSensitiveQuestion(label), true, label);
  }
  for (const label of ["Nombre", "¿Con cuál género te identificas?", "Estado civil", "Cargo equivalente"]) {
    assert.equal(isSensitiveQuestion(label), false, label);
  }
  const q = question({ label: "¿Tienes alguna discapacidad?", sensitive: true });
  assert.equal(savedProposal(q, buildAnswerIndex([saved("¿Tienes alguna discapacidad?", "No")])), null);
  assert.equal(shouldRemember(q, "No", []), false);
});

test("varias opciones: disponibilidad y modalidad sí; estado civil no", () => {
  assert.equal(looksMultiChoice("¿Cuál es tu disponibilidad?"), true);
  assert.equal(looksMultiChoice("Modalidad de trabajo"), true);
  assert.equal(looksMultiChoice("Selecciona tu estado civil actual"), false);
});

test("findOption: exacta, por prefijo («Soltero» → «Soltero(a)») o por palabras; si no, nada", () => {
  const options = [{ id: "a", label: "Soltero(a)" }, { id: "b", label: "Casado(a)" }, { id: "c", label: "Técnico profesional" }];
  assert.equal(findOption(options, "casado(a)")?.id, "b");
  assert.equal(findOption(options, "Soltero")?.id, "a");
  assert.equal(findOption(options, "profesional tecnico")?.id, "c");
  assert.equal(findOption(options, "Viudo"), null);
});

test("fechas: AAAA-MM-DD, DD/MM/AAAA y DDMMAAAA, validadas", () => {
  assert.equal(formatDate("1998-03-15"), "15/03/1998");
  assert.equal(formatDate("1998-03-15T00:00:00Z"), "15/03/1998");
  assert.equal(isoDate("2/11/1999"), "1999-11-02");
  assert.equal(dateDigits("15/03/1998"), "15031998");
  assert.equal(formatDate("31/02/2000"), null, "fecha imposible");
  assert.equal(formatDate("ayer"), null);
});

test("propuesta del perfil: «País» sí; «País de estudio» o «Ciudad donde trabajó» no (son otro momento)", () => {
  const values = resolveAutofillValues({ current_country: "Colombia", current_city: "Medellín", birth_date: "1998-03-15" });
  const country = question({ kind: "choice", label: "País", options: [{ id: "o1", label: "México" }, { id: "o2", label: "Colombia" }] });
  assert.deepEqual(profileProposal(country, values), { id: "q1", optionIds: ["o2"], source: "profile" });
  assert.equal(profileProposal(question({ kind: "choice", label: "País de estudio", options: country.options }), values), null);
  assert.equal(profileProposal(question({ label: "Ciudad donde trabajó" }), values), null);
  assert.deepEqual(profileProposal(question({ kind: "date", label: "Fecha de nacimiento" }), values), { id: "q1", text: "15/03/1998", source: "profile" });
});

test("respuestas guardadas: se convierten al tipo de pregunta (opción, varias, casilla)", () => {
  const index = buildAnswerIndex([
    saved("Selecciona tu estado civil actual", "Soltero(a)"),
    saved("¿Cuál es tu disponibilidad?", "Tiempo completo, Fines de semana"),
    saved("Acepto el tratamiento de datos", "Sí")
  ]);
  const civil = question({ kind: "choice", label: "Selecciona tu estado civil actual", options: [{ id: "a", label: "Casado(a)" }, { id: "b", label: "Soltero(a)" }] });
  assert.deepEqual(savedProposal(civil, index)?.optionIds, ["b"]);
  const availability = question({ kind: "multi", label: "¿Cuál es tu disponibilidad?", options: [{ id: "x", label: "Tiempo completo" }, { id: "y", label: "Medio tiempo" }, { id: "z", label: "Fines de semana" }] });
  assert.deepEqual(savedProposal(availability, index)?.optionIds, ["x", "z"]);
  assert.equal(answerText(availability, { id: "q1", optionIds: ["x", "z"] }), "Tiempo completo, Fines de semana");
  assert.equal(savedProposal(question({ kind: "checkbox", label: "Acepto el tratamiento de datos" }), index)?.checked, true);
});

test("recordar: no duplica una respuesta que ya está guardada igual", () => {
  const q = question({ label: "Título obtenido" });
  assert.equal(shouldRemember(q, "Ingeniería", [saved("Título obtenido", "ingenieria")]), false);
  assert.equal(shouldRemember(q, "Ingeniería de Sistemas", [saved("Título obtenido", "Ingeniería")]), true);
  assert.equal(shouldRemember(q, "  ", []), false);
});

/* ------------------------------ página ------------------------------ */

const PAGE = `
<header><input placeholder="Buscar empleos"></header>
<main><form>
  <fieldset><legend>¿Tienes licencia de conducción?</legend>
    <label><input type="radio" name="lic" value="si"> Sí</label>
    <label><input type="radio" name="lic" value="no"> No</label>
  </fieldset>
  <p>¿Puedes viajar?</p>
  <div class="ant-radio-group">
    <label class="ant-radio-wrapper"><span class="ant-radio"><input type="radio" class="ant-radio-input"></span><span>Sí</span></label>
    <label class="ant-radio-wrapper"><span class="ant-radio"><input type="radio" class="ant-radio-input"></span><span>No</span></label>
  </div>
  <label for="nivel">Nivel de inglés</label>
  <select id="nivel" required><option value="">Selecciona</option><option value="b1">B1</option><option value="b2">B2</option></select>
  <label for="inicio">Fecha de inicio</label><input id="inicio" type="date">
  <label><input type="checkbox" id="terms"> Acepto los términos y condiciones</label>
  <p>Idiomas que hablas</p>
  <div><label><input type="checkbox" name="lang" value="es"> Español</label><label><input type="checkbox" name="lang" value="en"> Inglés</label></div>
  <label for="ya">Teléfono</label><input id="ya" value="300 000 0000">
  <input type="file" id="cv"><label for="cv">Hoja de vida (PDF)</label>
  <input type="password" id="pw">
</form></main>`;

beforeEach(() => installDom(PAGE));

test("preguntas de la página: radios (con y sin name), lista, fecha, casillas; ignora lo lleno, contraseñas y el buscador", async () => {
  assert.equal(findFormScope(), document, "sin ventana abierta: la página");
  const scan = await collectQuestions(document);
  const summary = scan.items.map(({ question: q }) => `${q.kind}:${q.label}${q.required ? "*" : ""}:${q.options.map(o => o.label).join("/")}`);
  assert.deepEqual(summary, [
    "choice:¿Tienes licencia de conducción?:Sí/No",
    "choice:¿Puedes viajar?:Sí/No",
    "choice:Nivel de inglés*:B1/B2",
    "date:Fecha de inicio:",
    "checkbox:Acepto los términos y condiciones:",
    "multi:Idiomas que hablas:Español/Inglés"
  ]);
  assert.deepEqual(scan.files, ["Hoja de vida (PDF)"], "los archivos se reportan para que la persona los adjunte");
});

test("responder en la página: radio, lista, fecha (AAAA-MM-DD), casilla y varias casillas", async () => {
  const scan = await collectQuestions(document);
  const byLabel = (label: string) => scan.items.find(item => item.question.label.startsWith(label))!;
  const option = (label: string, text: string) => byLabel(label).question.options.find(o => o.label === text)!.id;

  assert.equal(await applyAnswer(byLabel("¿Tienes licencia").handle, { id: "", optionIds: [option("¿Tienes licencia", "No")] }, 0), true);
  assert.equal((document.querySelector('input[name="lic"][value="no"]') as HTMLInputElement).checked, true);
  assert.equal(await applyAnswer(byLabel("¿Puedes viajar").handle, { id: "", optionIds: [option("¿Puedes viajar", "Sí")] }, 0), true);
  assert.equal(await applyAnswer(byLabel("Nivel de inglés").handle, { id: "", optionIds: [option("Nivel de inglés", "B2")] }, 0), true);
  assert.equal((document.getElementById("nivel") as HTMLSelectElement).value, "b2");
  assert.equal(await applyAnswer(byLabel("Fecha de inicio").handle, { id: "", text: "01/12/2026" }, 0), true);
  assert.equal((document.getElementById("inicio") as HTMLInputElement).value, "2026-12-01");
  assert.equal(await applyAnswer(byLabel("Acepto").handle, { id: "", checked: true }, 0), true);
  const langs = byLabel("Idiomas");
  assert.equal(await applyAnswer(langs.handle, { id: "", optionIds: langs.question.options.map(o => o.id) }, 0), true);

  for (const item of scan.items) assert.equal(isHandleFilled(item.handle), true, item.question.label);
  assert.equal((await collectQuestions(document)).items.length, 0, "ya no queda nada vacío");
});

test("con una ventana abierta (role=dialog), solo cuenta lo de la ventana", async () => {
  installDom(`${PAGE}<div role="dialog"><label for="m">Cargo actual</label><input id="m"></div>`);
  const scope = findFormScope();
  assert.notEqual(scope, document);
  const scan = await collectQuestions(scope);
  assert.deepEqual(scan.items.map(item => item.question.label), ["Cargo actual"]);
});

/* ------------------------------ listas difíciles de Magneto ------------------------------ */

const SELECT2 = "mg_select2_input_magneto-ui-select2-input_button_14gdi";

/**
 * Como el paso «Datos complementarios» de una postulación: la lista «Disponible para» NO se cierra
 * con un clic en el fondo de la página (solo con un clic dentro de la ventana), y «Sector» admite
 * varias opciones: cada una queda como etiqueta «×» debajo y la lista sigue abierta tras elegir.
 */
function stubbornForm(): { clicks: Record<string, number> } {
  installDom(`
    <div class="mg_modal_magneto-ui-modal_x"><form id="form">
      <p>Completa los siguientes datos para terminar tu aplicación a la vacante</p>
      <div id="sector-field"><p>Sector o sectores laborales</p>
        <div class="select2-input" id="sector-wrap"><div style="display:none" id="sector-box"><input id="sector-input" name="Selecciona sectores laborales"></div>
          <button type="button" class="${SELECT2}" id="sector-btn">Selecciona sectores laborales</button></div>
        <div id="chips"></div></div>
      <div><p>Disponible para</p>
        <div class="select2-input" id="disp-wrap"><div style="display:none" id="disp-box"><input id="disp-input" name="Disponible para"></div>
          <button type="button" class="${SELECT2}" id="disp-btn">Disponible para</button></div></div>
      <button type="button" id="next">Siguiente</button>
    </form></div>`);
  const clicks: Record<string, number> = {};
  const byId = (id: string) => document.getElementById(id)!;
  const list = (id: string, options: string[], onPick: (t: string) => void) => {
    byId(`${id}-box`).style.display = "block";
    byId(`${id}-btn`).style.display = "none";
    document.getElementById(`${id}-list`)?.remove();
    const el = document.createElement("div");
    el.id = `${id}-list`;
    for (const text of options) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "select2-list__item mg_select2_list_magneto-ui-select2-list_i";
      b.textContent = text;
      b.addEventListener("click", () => onPick(text));
      el.append(b);
    }
    byId(`${id}-wrap`).append(el);
  };
  const close = (id: string) => {
    document.getElementById(`${id}-list`)?.remove();
    byId(`${id}-box`).style.display = "none";
    byId(`${id}-btn`).style.display = "";
  };
  byId("sector-btn").addEventListener("click", () => {
    clicks["sector"] = (clicks["sector"] ?? 0) + 1;
    list("sector", ["Salud", "Educación", "Administración y oficina"], text => {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.innerHTML = `<span>${text}</span><button type="button">×</button>`;
      byId("chips").append(chip); // la lista sigue abierta
    });
  });
  byId("disp-btn").addEventListener("click", () => {
    clicks["disp"] = (clicks["disp"] ?? 0) + 1;
    list("disp", ["Ninguno", "Práctica profesional"], text => { byId("disp-btn").textContent = text; close("disp"); });
  });
  // Clic en el fondo de la página: «Disponible para» NO se cierra (el modal se lo traga); Sector sí.
  document.addEventListener("mousedown", event => {
    const target = event.target as Node;
    if (!byId("sector-wrap").contains(target)) close("sector");
    if (target !== document.body && !byId("disp-wrap").contains(target)) close("disp");
  });
  byId("next").addEventListener("click", () => { clicks["next"] = (clicks["next"] ?? 0) + 1; });
  return { clicks };
}

test("lista que no se cierra con un clic fuera: se cierra con un clic dentro de la ventana, sin elegir nada", async () => {
  const { clicks } = stubbornForm();
  const scan = await collectQuestions(findFormScope(), { waitMs: 0 });
  const disp = scan.items.find(item => item.question.label === "Disponible para")!;
  assert.deepEqual(disp.question.options.map(o => o.label), ["Ninguno", "Práctica profesional"]);
  assert.equal(document.getElementById("disp-list"), null, "la lista quedó cerrada");
  assert.equal(document.getElementById("disp-btn")!.textContent, "Disponible para", "no se eligió nada");
  assert.equal(clicks["next"] ?? 0, 0, "nunca pulsa «Siguiente»");

  // Y después de leerla, elegir en otra lista funciona (antes el clic se perdía cerrando la lista trabada).
  const sector = scan.items.find(item => item.question.label === "Sector o sectores laborales")!;
  const salud = sector.question.options.find(o => o.label === "Salud")!.id;
  assert.equal(await applyAnswer(sector.handle, { id: "", optionIds: [salud] }, 0), true);
  assert.equal(document.getElementById("chips")!.textContent, "Salud×");
  assert.equal(document.getElementById("sector-list"), null, "tras elegir en una lista de varias opciones, se cierra");
  assert.equal(isHandleFilled(sector.handle), true, "la etiqueta «Salud ×» cuenta como llenado");
});

test("lista de varias opciones con una etiqueta ya elegida: no se pregunta y el adaptador no la vuelve a pulsar", async () => {
  const { clicks } = stubbornForm();
  document.getElementById("chips")!.innerHTML = `<span class="chip"><span>Salud</span><button type="button">×</button></span>`;
  const scan = await collectQuestions(findFormScope(), { waitMs: 0, probe: false });
  assert.ok(!scan.items.some(item => item.question.label.startsWith("Sector")), "Sector ya tiene «Salud»");
  const { planComplementaryModal } = await import("../src/content/complementary-form");
  const { resolveComplementaryValues } = await import("../src/shared/complementary-data");
  const plan = planComplementaryModal(resolveComplementaryValues({ desired_area: "Salud" }));
  assert.ok(plan.modal, "es el modal de datos complementarios");
  assert.ok(!plan.items.some(item => item.key === "sector"), "no se ofrece de nuevo (pulsarla la quitaría)");
  assert.equal(clicks["sector"] ?? 0, 0);
});

test("teléfono con «Indicativo país» aparte: si la página rechaza «+57…», se escriben solo los 10 dígitos", async () => {
  installDom(`<div class="row"><div><label>Indicativo país</label><button>+57 Colombia</button></div>
    <div><input id="tel" placeholder="Numero teléfono"></div></div>`);
  const input = document.getElementById("tel") as HTMLInputElement;
  // Como un campo controlado que solo acepta dígitos: borra cualquier otra cosa.
  input.addEventListener("input", () => { if (/\D/.test(input.value)) input.value = ""; });
  const { fillPhone, looksLikePhone } = await import("../src/content/dom-fields");
  assert.equal(looksLikePhone(input), true);
  assert.equal(await fillPhone(input, "+57 316 332 4904"), true);
  assert.equal(input.value, "3163324904");

  installDom(`<label for="t2">Celular</label><input id="t2">`);
  const plain = document.getElementById("t2") as HTMLInputElement;
  assert.equal(await fillPhone(plain, "+57 316 332 4904"), true);
  assert.equal(plain.value, "3163324904", "con indicativo, el número va sin él (la página permite máximo 10)");
});

test("crear cuenta (sitio público): solo cuenta la ventana abierta, y las tarjetas «Sexo registrado» son una pregunta de una opción", async () => {
  installDom(`
    <main>
      <label for="q1">Buscar por cargo o profesión</label><input id="q1">
      <label for="q2">Buscar por ubicación</label><input id="q2">
      <div class="jobs"><button class="jobCard-module__card___z">Auxiliar contable</button><button class="jobCard-module__card___z">Mensajero</button></div>
    </main>
    <div class="login-template-module__modal___x"><div class="content">
      <p>Dato requerido por el Servicio Público de Empleo</p>
      <p>Sexo registrado en tu documento de identidad</p>
      <div class="options">
        ${["Hombre", "Mujer", "Intersexual", "Otro"].map(t => `<div class="wrap"><button type="button" class="sexCard-module__card___ab"><img alt=""><div><p>${t}</p><p>Sexo registrado como ${t.toLowerCase()} en tu documento</p></div></button></div>`).join("")}
      </div>
      <button type="button" id="next">Siguiente</button>
    </div></div>`);
  const clicks: Record<string, number> = {};
  for (const card of document.querySelectorAll<HTMLButtonElement>(".sexCard-module__card___ab")) {
    card.addEventListener("click", () => {
      for (const other of document.querySelectorAll(".sexCard-module__card___ab")) other.classList.remove("sexCard-module__card--selected___ab");
      card.classList.add("sexCard-module__card--selected___ab");
    });
  }
  document.getElementById("next")!.addEventListener("click", () => { clicks["next"] = (clicks["next"] ?? 0) + 1; });

  const scope = findFormScope();
  assert.notEqual(scope, document, "la ventana de crear cuenta es el formulario, no la página de atrás");
  const scan = await collectQuestions(scope, { waitMs: 0 });
  assert.deepEqual(scan.items.map(({ question: q }) => `${q.kind}:${q.label}:${q.options.map(o => o.label).join("/")}`),
    ["choice:Sexo registrado en tu documento de identidad:Hombre/Mujer/Intersexual/Otro"],
    "ni los buscadores de atrás ni las ofertas de empleo");

  const sex = scan.items[0]!;
  const mujer = sex.question.options.find(o => o.label === "Mujer")!.id;
  assert.equal(await applyAnswer(sex.handle, { id: "", optionIds: [mujer] }, 0), true);
  assert.ok(document.querySelectorAll(".sexCard-module__card___ab")[1]!.classList.contains("sexCard-module__card--selected___ab"));
  assert.equal(clicks["next"] ?? 0, 0, "nunca pulsa «Siguiente»");

  // Sin ventana abierta: los buscadores y las tarjetas de ofertas tampoco son preguntas.
  document.querySelector(".login-template-module__modal___x")!.remove();
  assert.equal((await collectQuestions(findFormScope(), { waitMs: 0 })).items.length, 0);
});

test("perfil de Magneto: los títulos «Nivel 1…4» (levelLayout toggle-button) no son preguntas", async () => {
  installDom(`<div class="rightContainer">
    ${["Preferencias de ofertas a recibir", "Hazte visible para las empresas", "Haz que tu perfil destaque", "Entra en los candidatos TOP"].map(t =>
      `<article class="levelLayout-module__section-layout___Dz2TU"><button class="levelLayout-module__toggle-button___RDHzl"><div><h3>${t}</h3></div></button>
       <button class="mg_main_button">Añadir descripción del perfil</button></article>`).join("")}
  </div>`);
  assert.equal(findFormScope(), document);
  assert.equal((await collectQuestions(document, { waitMs: 0 })).items.length, 0);
});

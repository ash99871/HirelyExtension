import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installDom } from "./helpers/dom";
import { authorizedComplementaryValues, fillComplementaryModal, planComplementaryModal } from "../src/content/complementary-form";
import { resolveComplementaryValues } from "../src/shared/complementary-data";

/*
 * Fixture basado en el HTML real del modal «Completa los siguientes datos» de Magneto:
 * - desplegables select2: un <input> oculto (display:none) con el nombre real + un botón visible con el texto;
 * - Cargo: el botón abre un campo de búsqueda que aparece al abrir;
 * - tarjetas de modalidad con la clase CSS modules «…--selected___xxx» ya marcada en «Híbrido»;
 * - el botón «Siguiente» NO debe pulsarse.
 */

const SELECTED = "workModalityCard-module__work-modality-card--selected___SkzRf";
const SELECT2 = "mg_select2_input_magneto-ui-select2-input_button_14gdi";

const MODAL = `
<main>
<div id="modal" role="dialog">
  <h3>Completa los siguientes datos para terminar tu aplicación a la vacante</h3>

  <div class="form-layout__section">
    <h3>Sector o sectores laborales </h3>
    <div class="select2-input">
      <div style="display: none;"><input id="sector-hidden" name="Selecciona sectores laborales"><label for="sector-hidden">Selecciona sectores laborales</label></div>
      <button type="button" id="sector-btn" class="${SELECT2}"><span><p><span id="sector-text">Selecciona sectores laborales</span></p></span></button>
    </div>
  </div>

  <div class="form-layout__section">
    <h3>Escribe el cargo en el que quieres buscar empleo </h3>
    <div class="select2-input">
      <div style="display: none;"><input id="cargo-hidden" name="Agrega un cargo, oficio o profesión"></div>
      <button type="button" id="cargo-btn" class="${SELECT2}"><span><p><span id="cargo-text">Agrega un cargo, oficio o profesión</span></p></span></button>
    </div>
  </div>

  <div class="form-layout__section">
    <h3>Salario mínimo aceptado </h3>
    <div class="row">
      <div class="select2-input"><div style="display: none;"><input id="moneda-hidden" name="Moneda"></div>
        <button type="button" id="moneda-btn" class="${SELECT2}"><span><p><span>Moneda</span><span>COP</span></p></span></button></div>
      <div class="select2-input"><div style="display: none;"><input id="frec-hidden" name="Frecuencia de pago"></div>
        <button type="button" id="frec-btn" class="${SELECT2}"><span><p><span>Frecuencia de pago</span><span>Mensual</span></p></span></button></div>
      <div><label for="salary">Escriba un valor</label><input inputmode="numeric" maxlength="11" id="salary" name="salary" type="text" value="0"></div>
    </div>
  </div>

  <div class="form-layout__section">
    <h3>Último nivel de estudios </h3>
    <div class="select2-input">
      <div style="display: none;"><input id="edu-hidden" name="Nivel de estudios"><label for="edu-hidden">Nivel de estudios</label></div>
      <button type="button" id="edu-btn" class="${SELECT2}"><span><p><span id="edu-text">Nivel de estudios</span></p></span></button>
    </div>
  </div>

  <div class="form-layout__section">
    <h3>¿Dónde quieres trabajar? </h3>
    <div>
      <button class="workModalityCard-module__work-modality-card___5CcgN" type="button" id="remote"><h5>Remoto</h5><p>Trabaja desde donde prefieras, según las políticas de cada empresa.</p></button>
      <button class="workModalityCard-module__work-modality-card___5CcgN ${SELECTED}" type="button" id="hybrid"><h5>Híbrido</h5><p>Trabaja algunos días desde casa y otros en la oficina.</p></button>
      <button class="workModalityCard-module__work-modality-card___5CcgN" type="button" id="travel"><h5>Disponible para viajar</h5><p>Podrías ser requerido a desplazarte entre ciudades.</p></button>
    </div>
  </div>

  <div class="form-layout__section">
    <h3>¿Cuál es tu disponibilidad? </h3>
    <div><button class="mg_toggle_button_magneto-ui-toggle-button_1g06c  " type="button" id="full">Tiempo completo</button></div>
  </div>

  <button class="signUpNavigation-module__sign-up-navigation__next___OgnhR" type="button" id="next">Siguiente</button>
</div>
</main>`;

/** Sugerencias del buscador de cargo; cada prueba puede cambiarlas. */
let cargoOptions: string[] = ["Auxiliar Contable (Facturación)", "Auxiliar de Contabilidad"];

const clicks: Record<string, number> = {};
const count = (id: string) => () => { clicks[id] = (clicks[id] ?? 0) + 1; };

/** Lista emergente fuera del modal, como la de select2. */
function openList(anchor: HTMLElement, options: readonly string[], onPick: (text: string) => void): void {
  document.getElementById(`list-${anchor.id}`)?.remove();
  const list = document.createElement("ul");
  list.id = `list-${anchor.id}`;
  for (const text of options) {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.textContent = text;
    li.addEventListener("click", () => { onPick(text); list.remove(); });
    list.append(li);
  }
  document.body.append(list);
}

const byId = (id: string) => document.getElementById(id) as HTMLElement;
const setText = (id: string, text: string) => { byId(id).textContent = text; };

beforeEach(() => {
  installDom(MODAL);
  for (const key of Object.keys(clicks)) delete clicks[key];
  cargoOptions = ["Auxiliar Contable (Facturación)", "Auxiliar de Contabilidad"];

  for (const id of ["sector-hidden", "cargo-hidden", "moneda-hidden", "frec-hidden", "edu-hidden"]) {
    byId(id).addEventListener("click", count(id));
  }
  byId("sector-btn").addEventListener("click", () => {
    count("sector-btn")();
    openList(byId("sector-btn"), ["Salud", "Educación"], text => setText("sector-text", text));
  });
  byId("edu-btn").addEventListener("click", () => {
    count("edu-btn")();
    openList(byId("edu-btn"), ["Bachiller", "Tecnólogo", "Profesional"], text => setText("edu-text", text));
  });
  byId("cargo-btn").addEventListener("click", () => {
    count("cargo-btn")();
    if (document.getElementById("cargo-search")) return;
    const search = document.createElement("input");
    search.type = "text";
    search.id = "cargo-search";
    byId("cargo-btn").parentElement!.append(search);
    search.addEventListener("input", () => {
      if (search.value.length < 3) return;
      openList(search, cargoOptions, text => {
        setText("cargo-text", text);
        search.remove();
      });
    });
  });
  byId("remote").addEventListener("click", () => { count("remote")(); byId("remote").classList.toggle(SELECTED); });
  byId("hybrid").addEventListener("click", count("hybrid"));
  byId("travel").addEventListener("click", () => { count("travel")(); byId("travel").classList.toggle(SELECTED); });
  byId("full").addEventListener("click", count("full"));
  byId("next").addEventListener("click", count("next"));
});

const profile = {
  desired_area: "Salud",
  desired_position: "Auxiliar Contable",
  salary_expectation: 2000000,
  work_modality: "Híbrido",
  work_schedule: "Tiempo completo",
  willing_to_travel: true
};
const education = [{ level: "Tecnólogo", end_date: null }];

test("Magneto real: desplegables select2 se abren por su botón, nunca por el <input> oculto", async () => {
  const result = await fillComplementaryModal(resolveComplementaryValues(profile, education), { waitMs: 0 });
  const status = (target: string) => result.steps.find(step => step.target === target);

  assert.equal(status("Sector")?.status, "selected");
  assert.equal(byId("sector-text").textContent, "Salud", "el botón muestra la opción elegida");
  assert.equal(clicks["sector-hidden"] ?? 0, 0, "no se clickea el input oculto");

  assert.equal(status("Nivel de estudios")?.status, "selected");
  assert.equal(byId("edu-text").textContent, "Tecnólogo");
});

test("Magneto real: mismas palabras en otro orden en el buscador, elige por palabras en común (antes daba option-not-found)", async () => {
  cargoOptions = ["Contable Auxiliar de Facturación", "Mensajero"];
  const result = await fillComplementaryModal(resolveComplementaryValues(profile, education), { waitMs: 0 });
  const cargo = result.steps.find(step => step.target === "Cargo");
  assert.equal(cargo?.status, "selected-approx");
  assert.equal(cargo?.detail, "Contable Auxiliar de Facturación");
  assert.equal(byId("cargo-text").textContent, "Contable Auxiliar de Facturación");
});

test("Magneto real: el cargo escribe en el buscador que aparece y elige la sugerencia (revisar si no es exacta)", async () => {
  const result = await fillComplementaryModal(resolveComplementaryValues(profile, education), { waitMs: 0 });
  const cargo = result.steps.find(step => step.target === "Cargo");
  assert.equal(cargo?.status, "selected-approx", "«Auxiliar Contable (Facturación)» no es exacta: se marca para revisar");
  assert.equal(cargo?.detail, "Auxiliar Contable (Facturación)");
  assert.equal(byId("cargo-text").textContent, "Auxiliar Contable (Facturación)");
});

test("Magneto real: «Híbrido» ya marcado NO se desmarca; las demás opciones se marcan", async () => {
  const result = await fillComplementaryModal(resolveComplementaryValues(profile, education), { waitMs: 0 });
  const option = (name: string) => result.steps.find(step => step.target === `Opción: ${name}`)?.status;

  assert.equal(option("Híbrido"), "already-selected");
  assert.equal(clicks.hybrid ?? 0, 0, "no se hace clic en una opción que ya está marcada");
  assert.equal(option("Disponible para viajar"), "selected");
  assert.equal(byId("travel").classList.contains(SELECTED), true);
  assert.equal(option("Tiempo completo"), "clicked-unverified", "sin marca visible en el botón, se pide revisión");
});

test("Magneto real: salario y 'Siguiente' (que nunca se pulsa); Moneda/Frecuencia no se tocan", async () => {
  const result = await fillComplementaryModal(resolveComplementaryValues(profile, education), { waitMs: 0 });
  assert.equal(result.steps.find(step => step.target === "Salario")?.status, "filled");
  assert.equal((byId("salary") as HTMLInputElement).value, "2000000");
  assert.equal(clicks.next ?? 0, 0);
  assert.equal(byId("moneda-btn").textContent?.includes("COP"), true);
  assert.equal(clicks["moneda-hidden"] ?? 0, 0);
  assert.equal(clicks["frec-hidden"] ?? 0, 0);
});

/* ----------------------------- autorización ----------------------------- */

test("autorización: el plan del modal no hace clics ni escribe, y omite lo que ya está marcado", () => {
  const plan = planComplementaryModal(resolveComplementaryValues(profile, education));
  assert.ok(plan.modal, "encuentra el modal");
  assert.equal(Object.keys(clicks).length, 0, "planear no hace ningún clic");
  assert.equal((byId("salary") as HTMLInputElement).value, "0", "planear no escribe el salario");
  assert.deepEqual(plan.items.map(item => `${item.target}=${item.value}`), [
    "Sector=Salud",
    "Cargo=Auxiliar Contable",
    "Nivel de estudios=Tecnólogo",
    "Salario=2000000",
    "Opción=Disponible para viajar",
    "Opción=Tiempo completo"
  ], "«Híbrido» ya estaba marcado: no se ofrece");
});

test("autorización: solo se llena lo aprobado, con el valor editado; lo demás no se toca", async () => {
  const plan = planComplementaryModal(resolveComplementaryValues(profile, education));
  const approved = plan.items
    .filter(item => item.target === "Salario" || item.value === "Disponible para viajar")
    .map(item => (item.target === "Salario" ? { ...item, value: "$ 2.500.000" } : item));
  const result = await fillComplementaryModal(authorizedComplementaryValues(approved), { waitMs: 0 });

  assert.equal((byId("salary") as HTMLInputElement).value, "2500000", "salario editado, solo dígitos");
  assert.equal(byId("travel").classList.contains(SELECTED), true);
  assert.equal(byId("sector-text").textContent, "Selecciona sectores laborales", "Sector no autorizado: intacto");
  assert.equal(clicks["sector-btn"] ?? 0, 0);
  assert.equal(clicks.full ?? 0, 0, "Tiempo completo no autorizado: sin clic");
  assert.deepEqual(result.steps.map(step => step.target), ["Salario", "Opción: Disponible para viajar"]);
});

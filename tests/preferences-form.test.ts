import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installDom } from "./helpers/dom";
import {
  authorizedComplementaryValues,
  fillComplementaryModal,
  findComplementaryModal,
  planComplementaryModal
} from "../src/content/complementary-form";
import { cityOptionScore, resolveComplementaryValues } from "../src/shared/complementary-data";

/*
 * Fixture basado en el formulario real de Magneto que se abre desde el perfil con «Completar preferencias»
 * (leído el 17/11/2026): título «Déjanos conocer tus preferencias de empleo», botón «Guardar» y
 * «¿Dónde quieres trabajar?» como desplegable select2 cuyo <input> oculto se vuelve visible al abrirlo.
 * Al escribir «Medellín», Magneto lista primero ciudades homónimas de México.
 */
const SELECT2 = "mg_select2_input_magneto-ui-select2-input_button_14gdi";
const INPUT = "mg_input_magneto-ui-input--container_input_tifvx";

const select2 = (id: string, name: string): string => `
    <div class="select2-input" id="${id}-wrap">
      <div style="display: none;" id="${id}-box"><input class="${INPUT}" id="${name}" name="${name}" type="text"></div>
      <button type="button" id="${id}-btn" class="${SELECT2}"><span><p><span id="${id}-text">${name}</span></p></span></button>
    </div>`;

const FORM = `
<div role="dialog">
  <form class="ant-form formLayout-module__form-layout___lfdnH">
    <h2>Déjanos conocer tus preferencias de empleo</h2>
    <div class="section"><h3>Sector o sectores laborales *</h3>${select2("sector", "Selecciona sectores laborales")}</div>
    <div class="section"><h3>Escribe el cargo en el que quieres buscar empleo *</h3>${select2("cargo", "Agrega un cargo, oficio o profesión")}</div>
    <div class="section"><h3>Salario mínimo aceptado *</h3>
      <div class="row">${select2("moneda", "Moneda")}${select2("frec", "Frecuencia de pago")}
        <div><label for="salary">Escriba un valor</label><input class="${INPUT}" id="salary" name="salary" type="text" value="0"></div></div></div>
    <div class="section"><h3>Último nivel de estudios *</h3>${select2("edu", "Nivel de estudios")}</div>
    <div class="section"><h3>¿Dónde quieres trabajar? *</h3>${select2("city", "Ciudad")}</div>
    <div class="section"><button type="button" class="workModalityCard-module__work-modality-card___5CcgN" id="remote"><h5>Remoto</h5><p>Trabaja desde donde prefieras.</p></button></div>
    <div class="section"><h3>¿Cuál es tu disponibilidad? *</h3><button type="button" class="mg_toggle_button_magneto-ui-toggle-button_1g06c" id="full">Tiempo completo</button></div>
    <button type="button" class="formLayout-module__form-layout__button___dxO-A" id="save">Guardar</button>
  </form>
</div>`;

const CITY_OPTIONS = [
  "Medellín, Veracruz de Ignacio de la Llave, México",
  "Medellín de Bravo, Veracruz de Ignacio de la Llave, México",
  "Medellín y Madero Segunda Sección, Tabasco, México",
  "Medellín, Antioquia, Colombia"
];

const byId = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
const clicks: Record<string, number> = {};

beforeEach(() => {
  installDom(FORM);
  for (const key of Object.keys(clicks)) delete clicks[key];
  byId("save").addEventListener("click", () => { clicks["save"] = (clicks["save"] ?? 0) + 1; });
  // Como en Magneto: al abrir «Ciudad», el botón da paso al <input> (antes oculto) donde se escribe.
  byId("city-btn").addEventListener("click", () => {
    clicks["city"] = (clicks["city"] ?? 0) + 1;
    byId("city-box").style.display = "block";
    byId("city-btn").style.display = "none";
    const input = byId("Ciudad") as HTMLInputElement;
    input.addEventListener("input", () => {
      document.getElementById("city-list")?.remove();
      if (input.value.length < 3) return;
      const list = document.createElement("div");
      list.id = "city-list";
      for (const text of CITY_OPTIONS) {
        const option = document.createElement("button");
        option.type = "button";
        option.className = "select2-list__item mg_select2_list_magneto-ui-select2-list_i";
        option.textContent = text;
        option.addEventListener("click", () => {
          byId("city-text").textContent = text;
          byId("city-box").style.display = "none";
          byId("city-btn").style.display = "";
          list.remove();
        });
        list.append(option);
      }
      byId("city-wrap").append(list);
    });
  });
});

const profile = { desired_area: "Salud", salary_expectation: 2500000, current_city: "Medellín", current_country: "Colombia" };

test("preferencias: reconoce el formulario «Déjanos conocer tus preferencias de empleo» (botón «Guardar»)", () => {
  const modal = findComplementaryModal();
  assert.ok(modal, "antes no se detectaba: solo se buscaba «Completa los siguientes datos» con «Siguiente»");
  assert.equal(modal.tagName, "FORM");
});

test("preferencias: la ciudad del perfil entra en la lista de autorización, sin tocar la página", () => {
  const plan = planComplementaryModal(resolveComplementaryValues(profile));
  assert.deepEqual(plan.items.map(item => `${item.target}=${item.value}`), ["Sector=Salud", "Salario=2500000", "Ciudad=Medellín"]);
  assert.equal(clicks["city"] ?? 0, 0, "planear no abre el desplegable");
});

test("preferencias: elige «Medellín, Antioquia, Colombia» aunque Magneto liste primero las de México; nunca pulsa «Guardar»", async () => {
  const values = resolveComplementaryValues(profile);
  const plan = planComplementaryModal(values);
  const city = plan.items.filter(item => item.target === "Ciudad");
  const result = await fillComplementaryModal(authorizedComplementaryValues(city, values), { waitMs: 0 });
  assert.equal(byId("city-text").textContent, "Medellín, Antioquia, Colombia");
  assert.deepEqual(result.steps, [{ target: "Ciudad", status: "selected", detail: "Medellín, Antioquia, Colombia" }], "se informa cuál ciudad se eligió");
  assert.equal(clicks["save"] ?? 0, 0);
});

test("preferencias: sin país en el perfil, la ciudad elegida queda marcada para revisar", async () => {
  const values = resolveComplementaryValues({ current_city: "Medellín" });
  const result = await fillComplementaryModal(values, { waitMs: 0 });
  assert.equal(result.steps[0]?.status, "selected-approx");
});

test("cityOptionScore: el país del perfil pesa más que el orden; otra ciudad no cuenta", () => {
  assert.equal(cityOptionScore("Medellín, Antioquia, Colombia", "Medellin", "Colombia"), 6);
  assert.equal(cityOptionScore("Medellín, Veracruz de Ignacio de la Llave, México", "Medellín", "Colombia"), 2);
  assert.equal(cityOptionScore("Medellín de Bravo, Veracruz, México", "Medellín", "Colombia"), 1);
  assert.equal(cityOptionScore("Bogotá, Bogotá D.C., Colombia", "Medellín", "Colombia"), 0);
});

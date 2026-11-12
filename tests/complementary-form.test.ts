import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installDom } from "./helpers/dom";
import { scanFormFields } from "../src/content/dom-fields";
import { fillComplementaryModal, findComplementaryModal, isInside, summarizeComplementary } from "../src/content/complementary-form";
import {
  educationBand,
  moneyToDigits,
  optionCoverageScore,
  optionMatchScore,
  recognizeComplementaryField,
  resolveComplementaryValues,
  scheduleOptions
} from "../src/shared/complementary-data";

/* ----------------------------- lógica pura ----------------------------- */

test("reconoce cada control por su texto y excluye la fila de moneda/frecuencia del salario", () => {
  const hint = (text: string, depth: number) => ({ text, depth });
  assert.equal(recognizeComplementaryField([hint("sectores laborales", 0)], ""), "sector");
  assert.equal(recognizeComplementaryField([hint("agrega un cargo oficio o profesion", 0)], ""), "job_title");
  assert.equal(recognizeComplementaryField([hint("nivel de estudios", 1)], ""), "education_level");
  assert.equal(recognizeComplementaryField([hint("salario minimo aceptado", 3)], "escriba un valor"), "salary");
  assert.equal(recognizeComplementaryField([hint("salario minimo aceptado", 3)], "moneda cop"), null, "moneda no es el monto");
  assert.equal(recognizeComplementaryField([hint("salario minimo aceptado", 3)], "frecuencia de pago mensual"), null);
  assert.equal(recognizeComplementaryField([hint("nombre", 0)], ""), null, "campos ajenos quedan fuera");
});

test("ante dos pistas, gana la más cercana al control (el cargo no se confunde con el sector)", () => {
  const hints = [{ text: "sectores laborales", depth: 4 }, { text: "agrega un cargo", depth: 1 }];
  assert.equal(recognizeComplementaryField(hints, ""), "job_title");
});

test("optionMatchScore: exacta > prefijo > sin coincidencia; ignora acentos y mayúsculas", () => {
  assert.equal(optionMatchScore("Híbrido", "hibrido"), 2);
  assert.equal(optionMatchScore("Disponible para viajarPodrías ser requerido", "Disponible para viajar"), 1);
  assert.equal(optionMatchScore("Medio tiempo", "Tiempo completo"), 0);
});

test("resolveComplementaryValues usa las columnas reales del esquema", () => {
  const values = resolveComplementaryValues(
    {
      desired_area: " Salud ",
      desired_position: "Auxiliar Contable",
      salary_expectation: 2000000,
      work_modality: "Remoto",
      willing_to_travel: true,
      willing_to_relocate: false,
      work_schedule: "Tiempo completo",
      schedule_availability: "Inmediata"
    },
    [{ level: "Bachiller", end_date: "2015-12-01" }, { level: "Tecnólogo", end_date: "2024-06-30" }]
  );
  assert.deepEqual(values, {
    sector: "Salud",
    jobTitle: "Auxiliar Contable",
    educationLevel: "Tecnólogo",
    salary: "2000000",
    workPreferences: ["Remoto", "Disponible para viajar", "Tiempo completo"]
  });
});

test("textos exactos de las listas de Hirely (Modalidad) llegan a las opciones correctas", () => {
  // Valores tal como los muestra el desplegable y se guardan en profiles.work_modality.
  assert.deepEqual(resolveComplementaryValues({ work_modality: "Remoto" }).workPreferences, ["Remoto"]);
  assert.deepEqual(resolveComplementaryValues({ work_modality: "Híbrido" }).workPreferences, ["Híbrido"]);
  assert.deepEqual(resolveComplementaryValues({ work_modality: "Presencial" }).workPreferences, [], "Magneto no tiene «Presencial»");
  // «Selecciona...» equivale a no elegir nada.
  assert.deepEqual(resolveComplementaryValues({ work_modality: "Selecciona..." }).workPreferences, []);
});

test("desplegables: solo se envían valores que Magneto tiene; «Presencial» y la disponibilidad en texto se ignoran", () => {
  assert.deepEqual(resolveComplementaryValues({ work_modality: "Presencial" }).workPreferences, []);
  assert.deepEqual(resolveComplementaryValues({ work_modality: "hibrido" }).workPreferences, ["Híbrido"], "sin acentos");
  assert.deepEqual(resolveComplementaryValues({ work_schedule: "Por horas" }).workPreferences, ["Por horas"]);
  assert.deepEqual(resolveComplementaryValues({ schedule_availability: "Inmediata" }).workPreferences, [], "texto libre");
  assert.deepEqual(resolveComplementaryValues({ work_modality: "Remoto", work_schedule: "Remoto" }).workPreferences, ["Remoto"], "sin duplicados");
});

test("salario en texto con separadores, opciones repetidas y campos vacíos", () => {
  const values = resolveComplementaryValues({ salary_expectation: "2.500.000", work_modality: "Presencial", willing_to_relocate: null });
  assert.equal(values.salary, "2500000");
  assert.deepEqual(values.workPreferences, []);
  assert.deepEqual(resolveComplementaryValues({}).workPreferences, []);
  assert.equal(resolveComplementaryValues({}).salary, "");
});

test("tipo de título: lo que viene después de «en» no cambia la clasificación", () => {
  const band = (text: string) => educationBand(text);
  // Tecnólogo/a y técnico/a seguidos de cualquier programa
  assert.equal(band("Tecnólogo en Desarrollo de Software"), "tecnologo");
  assert.equal(band("Tecnóloga en Gestión Ambiental y Sostenibilidad"), "tecnologo");
  assert.equal(band("Técnico en Mantenimiento de Equipos Biomédicos"), "tecnico");
  assert.equal(band("Técnica en Enfermería"), "tecnico");
  assert.equal(band("Técnico profesional en mecánica industrial"), "tecnico");
  assert.equal(band("Tecnología en desarrollo de software"), "tecnologo", "«Tecnología en…» es el nombre habitual del programa");
  // La palabra clave aparece después de «en»: NO define el tipo
  assert.equal(band("Ingeniero en tecnología de alimentos"), "profesional");
  assert.equal(band("Profesional en tecnologías de la información"), "profesional");
  assert.equal(band("Tecnólogo en Administración de Empresas"), "tecnologo", "«administración» no es posgrado");
  // Posgrado sí se reconoce en cualquier parte del texto
  assert.equal(band("Abogado con especialización en derecho penal"), "posgrado");
  assert.equal(band("Maestría en educación"), "posgrado");
});

test("posgrados: especialidades médicas y de otras carreras se reconocen aunque no digan «especialización»", () => {
  // Médicos: el posgrado se nombra por la especialidad
  assert.equal(educationBand("Especialista en Cardiología"), "posgrado");
  assert.equal(educationBand("Residencia en Pediatría"), "posgrado");
  assert.equal(educationBand("Cirugía general"), "posgrado");
  assert.equal(educationBand("Medicina interna"), "posgrado");
  assert.equal(educationBand("Médico radiólogo"), "posgrado");
  assert.equal(educationBand("Ortopedia y traumatología"), "posgrado");
  // Pregrado de medicina: sigue siendo profesional
  assert.equal(educationBand("Médico cirujano"), "profesional");
  assert.equal(educationBand("Medicina"), "profesional");
  // Otras carreras
  assert.equal(educationBand("MBA en Finanzas"), "posgrado");
  assert.equal(educationBand("Master en Gestión de Proyectos"), "posgrado");
  assert.equal(educationBand("Magíster en Educación"), "posgrado");
  assert.equal(educationBand("PhD en Biología"), "posgrado");
  // Técnicos y tecnólogos en áreas de salud NO se vuelven posgrado
  assert.equal(educationBand("Tecnólogo en radiología"), "tecnologo");
  assert.equal(educationBand("Técnico en urgencias"), "tecnico");
  // Diplomados no cuentan como posgrado (decisión a confirmar)
  assert.equal(educationBand("Diplomado en gestión de proyectos"), "profesional");
});

test("posgrado médico en un campo y pregrado en otro: gana el posgrado", () => {
  const level = (rows: Record<string, string | null>[]) => resolveComplementaryValues({}, rows).educationLevel;
  assert.equal(level([{ degree: "Médico cirujano", program: "Cardiología" }]), "Especialización/Maestría");
  assert.equal(level([{ degree: "Tecnólogo en radiología" }, { degree: "Médico cirujano" }]), "Profesional");
});

test("nivel de estudios: cada campo se clasifica por separado y se conserva el más alto", () => {
  const level = (rows: Record<string, string | null>[]) => resolveComplementaryValues({}, rows).educationLevel;
  // Un técnico con título de tecnólogo en otro campo: gana el tecnólogo
  assert.equal(level([{ level: "Técnico", degree: "Tecnólogo en Desarrollo de Software" }]), "Tecnólogo");
  // Un ingeniero no se confunde con tecnólogo por la palabra «tecnología» del programa
  assert.equal(level([{ degree: "Ingeniero en tecnología de alimentos" }]), "Profesional");
  // Programa de posgrado en un campo distinto al título
  assert.equal(level([{ degree: "Abogado", program: "Especialización en derecho penal" }]), "Especialización/Maestría");
});

test("nivel de estudios: clasifica por el tipo de título y conserva el más alto del perfil", () => {
  const level = (rows: Record<string, string | null>[]) => resolveComplementaryValues({}, rows).educationLevel;
  // Educación primaria → Básica primaria
  assert.equal(level([{ level: "Educación primaria" }]), "Básica primaria");
  // Sin título de bachiller, técnico ni tecnólogo → Profesional
  assert.equal(level([{ degree: "Ingeniería industrial" }]), "Profesional");
  assert.equal(level([{ degree: "Abogado" }]), "Profesional");
  // Bachiller, técnico y tecnólogo se reconocen por su nombre
  assert.equal(level([{ degree: "Bachiller académico" }]), "Bachiller");
  assert.equal(level([{ degree: "Técnico en sistemas" }]), "Técnico");
  assert.equal(level([{ degree: "Tecnología en desarrollo de software" }]), "Tecnólogo");
  // Especialización o maestría → Especialización/Maestría
  assert.equal(level([{ program: "Especialización en derecho penal" }]), "Especialización/Maestría");
  // El más alto de todos los registros gana
  assert.equal(level([{ degree: "Bachiller académico" }, { degree: "Abogado" }, { program: "Maestría en educación" }]), "Especialización/Maestría");
  assert.equal(level([{ degree: "Técnico en sistemas" }, { degree: "Bachiller académico" }]), "Técnico");
  assert.equal(level([]), "", "sin estudios no se elige nada");
  assert.equal(level([{ level: null, degree: null, program: null }]), "", "registros vacíos se ignoran");
});


test("montos: Magneto pone los puntos solo; los decimales con ceros no se convierten en miles", () => {
  assert.equal(moneyToDigits("2000000.00"), "2000000", "decimales con ceros");
  assert.equal(moneyToDigits("2.000.000"), "2000000", "puntos de miles");
  assert.equal(moneyToDigits("2000000,5"), "2000000", "un decimal");
  assert.equal(moneyToDigits("2,500"), "2500", "coma seguida de tres cifras es miles");
  assert.equal(resolveComplementaryValues({ salary_expectation: "2000000.00" }).salary, "2000000");
  assert.equal(resolveComplementaryValues({ salary_expectation: 2000000 }).salary, "2000000");
});

test("jornada en texto libre: solo las opciones que el texto dice con claridad", () => {
  assert.deepEqual(scheduleOptions("Lunes a viernes, jornada diurna"), ["Jornada diurna"]);
  assert.deepEqual(scheduleOptions("Inmediata"), [], "disponibilidad sin jornada");
  assert.deepEqual(scheduleOptions("Fines de semana y turnos nocturnos"), ["Jornada nocturna", "Fines de semana"]);
  assert.deepEqual(scheduleOptions("Medio tiempo"), ["Medio tiempo"], "medio tiempo no se confunde con tiempo completo");
  assert.deepEqual(resolveComplementaryValues({ schedule_availability: "Inmediata", work_schedule: "Tiempo completo" }).workPreferences, ["Tiempo completo"]);
});

test("coincidencia aproximada: cuenta palabras en común con el texto libre", () => {
  assert.equal(optionCoverageScore("Tecnología, informática y telecomunicaciones", "Tecnología"), 1);
  assert.equal(optionCoverageScore("Tecnología, informática y telecomunicaciones", "tecnologia informatica"), 1, "sin acentos");
  assert.equal(optionCoverageScore("Salud", "Secretaria, atención al cliente"), 0);
  assert.equal(optionCoverageScore("Servicio al cliente", "Secretaria, atención al cliente"), 1 / 3);
  assert.equal(optionCoverageScore("Salud", "de la"), 0, "palabras vacías no cuentan");
});

/* ------------------------------ DOM simulado ------------------------------ */

/** Opciones del desplegable de sector; cada prueba puede cambiarlas. */
let sectorOptions: string[] = ["Salud", "Tecnología"];
/** Sugerencias del campo de cargo; cada prueba puede cambiarlas. */
let jobOptions: string[] = ["Auxiliar Contable (Facturación)", "Auxiliar de Contabilidad"];

/** Lista emergente fuera del modal (como un portal), creada al abrir un desplegable. */
function openList(anchor: HTMLElement, options: readonly string[], onPick: (text: string) => void): void {
  const id = `list-${anchor.id}`;
  document.getElementById(id)?.remove();
  const list = document.createElement("ul");
  list.id = id;
  list.setAttribute("role", "listbox");
  for (const text of options) {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.textContent = text;
    li.addEventListener("click", () => { onPick(text); list.remove(); });
    list.append(li);
  }
  document.body.append(list);
}

const MODAL = `
<main>
  <aside>
    <button id="side-tc" class="card">Tiempo completo</button>
    <input id="search" name="q" placeholder="Buscar empleo">
  </aside>
  <form id="form">
  <div id="modal" role="dialog">
    <h2>Completa los siguientes datos para terminar tu aplicación a la vacante</h2>
    <div class="block">
      <p>Sector o sectores laborales</p>
      <div class="field"><input id="sector" placeholder="Selecciona sectores laborales"></div>
    </div>
    <div class="block">
      <p>Escribe el cargo en el que quieres buscar empleo</p>
      <div class="field"><input id="job" placeholder="Agrega un cargo, oficio o profesión"></div>
    </div>
    <div class="block">
      <p>Salario mínimo aceptado</p>
      <div class="row">
        <div class="cell"><span>Moneda</span><span>COP</span><input id="moneda" value="COP"></div>
        <div class="cell"><span>Frecuencia de pago</span><input id="frec" value="Mensual"></div>
        <div class="cell"><span>Escriba un valor</span><input id="salary" name="salary" value="0"></div>
      </div>
    </div>
    <div class="block">
      <p>Último nivel de estudios</p>
      <div class="field"><input id="edu" placeholder="Nivel de estudios"></div>
    </div>
    <div class="block">
      <p>¿Dónde quieres trabajar?</p>
      <button id="remote" class="chip" aria-pressed="false"><span>Remoto</span><small>Trabaja desde donde prefieras</small></button>
      <div class="card" id="fulltime"><h4>Tiempo completo</h4><p>Jornada completa</p></div>
    </div>
    <button id="next" type="submit">Siguiente</button>
  </div>
  </form>
</main>`;

let submissions: Event[] = [];
let nextClicks = 0;

beforeEach(() => {
  installDom(MODAL);
  submissions = [];
  nextClicks = 0;
  sectorOptions = ["Salud", "Tecnología"];
  jobOptions = ["Auxiliar Contable (Facturación)", "Auxiliar de Contabilidad"];
  const doc = document;
  // Los elementos se capturan una vez: así el fixture sigue funcionando aunque se muevan a un shadow root.
  const sector = doc.getElementById("sector") as HTMLInputElement;
  const edu = doc.getElementById("edu") as HTMLInputElement;
  const job = doc.getElementById("job") as HTMLInputElement;
  const remote = doc.getElementById("remote") as HTMLElement;
  const fulltime = doc.getElementById("fulltime") as HTMLElement;
  const next = doc.getElementById("next") as HTMLElement;
  const form = doc.getElementById("form") as HTMLElement;

  sector.addEventListener("click", () => openList(sector, sectorOptions, text => { sector.value = text; }));
  edu.addEventListener("click", () => openList(edu, ["Bachiller", "Tecnólogo", "Profesional"], text => { edu.value = text; }));
  job.addEventListener("input", () => {
    if (job.value.length < 3) return;
    openList(job, jobOptions, text => { job.value = text; });
  });
  remote.addEventListener("click", () => remote.setAttribute("aria-pressed", "true"));
  fulltime.addEventListener("click", () => fulltime.classList.toggle("selected"));
  next.addEventListener("click", () => { nextClicks++; });
  form.addEventListener("submit", event => submissions.push(event));
});

const profile = {
  desired_area: "Salud",
  desired_position: "Auxiliar Contable",
  salary_expectation: 2000000,
  work_modality: "Remoto",
  work_schedule: "Tiempo completo",
  schedule_availability: "Inmediata"
};
const education = [{ level: "Tecnólogo", end_date: null }];

test("el modal dentro de un Shadow DOM abierto (como en Magneto) se encuentra y se rellena igual", async () => {
  // Magneto no deja el modal en el HTML principal: vive dentro de un custom element con shadow root abierto.
  const host = document.createElement("magneto-app");
  document.querySelector("main")!.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  shadow.append(document.getElementById("form")!);

  const modal = findComplementaryModal();
  assert.ok(modal, "encuentra el modal dentro del shadow root");
  const result = await fillComplementaryModal(resolveComplementaryValues(profile, education), { waitMs: 0 });
  assert.equal(result.modal, modal);
  assert.equal((shadow.getElementById("sector") as HTMLInputElement).value, "Salud");
  assert.equal((shadow.getElementById("salary") as HTMLInputElement).value, "2000000");
  assert.equal(nextClicks, 0, "«Siguiente» dentro del shadow tampoco se pulsa");
});

test("cargo (campo de texto simple): mismas palabras en otro orden, elige por palabras en común y lo marca para revisar", async () => {
  // «Contable Auxiliar de Facturación» tiene las mismas palabras que «Auxiliar Contable» pero no es un prefijo: antes daba option-not-found.
  jobOptions = ["Contable Auxiliar de Facturación", "Mensajero"];
  const result = await fillComplementaryModal(resolveComplementaryValues({ desired_position: "Auxiliar Contable" }), { waitMs: 0 });
  const cargo = result.steps.find(step => step.target === "Cargo");
  assert.equal(cargo?.status, "selected-approx");
  assert.equal(cargo?.detail, "Contable Auxiliar de Facturación");
  assert.equal((document.getElementById("job") as HTMLInputElement).value, "Contable Auxiliar de Facturación");
});

test("cargo (campo de texto simple): sin ninguna sugerencia parecida, no elige nada (queda lo que se escribió)", async () => {
  jobOptions = ["Mensajero", "Conductor"];
  const result = await fillComplementaryModal(resolveComplementaryValues({ desired_position: "Auxiliar Contable" }), { waitMs: 0 });
  assert.equal(result.steps.find(step => step.target === "Cargo")?.status, "option-not-found");
  // El cargo se escribe para que aparezcan sugerencias; sin ninguna parecida, el texto escrito se deja tal cual.
  assert.equal((document.getElementById("job") as HTMLInputElement).value, "Auxiliar Contable");
});

test("desplegable: si Hirely usa otras palabras, elige la opción que mejor coincide y la marca para revisar", async () => {
  sectorOptions = ["Salud", "Tecnología, informática y telecomunicaciones", "Educación"];
  const result = await fillComplementaryModal(resolveComplementaryValues({ desired_area: "tecnologia informatica" }), { waitMs: 0 });
  const sector = result.steps.find(step => step.target === "Sector");
  assert.equal(sector?.status, "selected-approx");
  assert.match(sector?.detail ?? "", /^Tecnología, informática/);
  assert.equal((document.getElementById("sector") as HTMLInputElement).value, "Tecnología, informática y telecomunicaciones");
  assert.match(summarizeComplementary(result), /Revisar: Sector \(elegí «Tecnología, informática/);
});

test("desplegable: sin coincidencia clara no elige nada", async () => {
  const result = await fillComplementaryModal(resolveComplementaryValues({ desired_area: "Secretaria, atención al cliente" }), { waitMs: 0 });
  assert.equal(result.steps.find(step => step.target === "Sector")?.status, "option-not-found");
  assert.equal((document.getElementById("sector") as HTMLInputElement).value, "", "el campo queda vacío");
});

test("sin modal visible no hace nada y devuelve un resultado vacío", async () => {
  document.getElementById("modal")!.remove();
  const result = await fillComplementaryModal(resolveComplementaryValues(profile, education), { waitMs: 0 });
  assert.equal(result.modal, null);
  assert.deepEqual(result.steps, []);
  assert.equal(summarizeComplementary(result), "");
});

test("rellena desplegables, sugerencias, salario y elecciones dentro del modal", async () => {
  const result = await fillComplementaryModal(resolveComplementaryValues(profile, education), { waitMs: 0 });
  const value = (id: string) => (document.getElementById(id) as HTMLInputElement).value;

  assert.equal(value("sector"), "Salud", "desplegable de sector elegido por texto exacto");
  assert.equal(value("job"), "Auxiliar Contable (Facturación)", "sugerencia tras escribir, elegida de la lista");
  assert.equal(value("edu"), "Tecnólogo", "nivel de estudios");
  assert.equal(value("salary"), "2000000", "salario con el monto del perfil");
  assert.equal(document.getElementById("remote")!.getAttribute("aria-pressed"), "true");
  assert.equal(document.getElementById("fulltime")!.classList.contains("selected"), true);

  assert.deepEqual(result.steps.map(step => step.status), [
    "selected", "selected-approx", "selected", "filled", "selected", "selected"
  ]);
  assert.match(summarizeComplementary(result), /5 de 6 listos\. Revisar: Cargo \(elegí «Auxiliar Contable \(Facturación\)»\)\. Discapacidad: responde tú\./);
});

test("no pisa un salario que ya fue escrito y no toca moneda ni frecuencia", async () => {
  (document.getElementById("salary") as HTMLInputElement).value = "2500000";
  const result = await fillComplementaryModal(resolveComplementaryValues(profile, education), { waitMs: 0 });
  assert.equal((document.getElementById("salary") as HTMLInputElement).value, "2500000");
  assert.equal((document.getElementById("moneda") as HTMLInputElement).value, "COP");
  assert.equal((document.getElementById("frec") as HTMLInputElement).value, "Mensual");
  assert.equal(result.steps.find(step => step.target === "Salario")?.status, "already-filled");
});

test("nunca pulsa Siguiente ni envía el formulario, aunque un chip sea un botón dentro de <form>", async () => {
  await fillComplementaryModal(resolveComplementaryValues(profile, education), { waitMs: 0 });
  assert.equal(nextClicks, 0, "«Siguiente» no se pulsa");
  assert.equal(submissions.filter(event => !event.defaultPrevented).length, 0, "ningún envío sin cancelar");
});

test("una opción que no existe se reporta, no se inventa, y la fuera del modal no se toca", async () => {
  const result = await fillComplementaryModal(
    resolveComplementaryValues({ willing_to_travel: true, desired_area: "Minería" }),
    { waitMs: 0 }
  );
  assert.equal(result.steps.find(step => step.target === "Sector")?.status, "option-not-found");
  assert.equal(result.steps.find(step => step.target === "Opción: Disponible para viajar")?.status, "option-not-found");
  assert.equal(document.getElementById("side-tc")!.classList.contains("selected"), false, "el filtro de la página no se marca");
  assert.match(summarizeComplementary(result), /Revisar: Sector, Opción: Disponible para viajar\./);
});

test("el escáner genérico ignora los controles del modal: no compiten con este adaptador", async () => {
  const modal = findComplementaryModal();
  assert.ok(modal, "encuentra el modal");
  const scan = await scanFormFields(document, { exclude: el => isInside(modal, el) });
  const inside = [...scan.elements.values()].filter(el => isInside(modal!, el));
  assert.equal(inside.length, 0);
  assert.ok(scan.fields.some(field => field.hints.includes("q")), "el buscador de fuera del modal sigue escaneándose");
});

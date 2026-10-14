import { test } from "node:test";
import assert from "node:assert/strict";
import { matchProfileToFields, resolveAutofillValues, resolveOption } from "../src/shared/field-mapping";
import { detectOpenQuestions } from "../src/shared/question-detection";
import type { FieldDescriptor } from "../src/shared/types";

let n = 0;
const field = (over: Partial<FieldDescriptor>): FieldDescriptor => ({
  id: `f${++n}`, kind: "input", inputType: "text", label: "", hints: "", value: "", options: [], maxLength: -1, size: 20, ...over
});

const PROFILE = {
  first_name: "Ana", last_name: "Pérez", email: "ana@correo.co", phone: "3001234567",
  current_country: "Colombia", linkedin_url: "https://linkedin.com/in/ana", education: [{ school: "UdeA" }], summary: { nested: true }
};

test("resolveAutofillValues solo conserva campos usados y descarta objetos", () => {
  const values = resolveAutofillValues(PROFILE);
  assert.equal(values.first_name, "Ana");
  assert.equal(values.full_name, "Ana Pérez", "full_name se compone de nombre + apellido");
  assert.equal(values.career_objective, undefined, "un objeto nunca debe convertirse en «[object Object]»");
  assert.ok(!("education" in values));
});

test("mapea por etiqueta (ES/EN), por atributo name camelCase/snake_case y por autocomplete", () => {
  const fields = [
    field({ label: "Nombre(s)" }),
    field({ label: "Last name" }),
    field({ hints: "firstName" }),
    field({ hints: "phone_number" }),
    field({ label: "Perfil de LinkedIn" }),
    field({ hints: "given-name" })
  ];
  const keys = matchProfileToFields(PROFILE, fields).map(m => m.key);
  assert.deepEqual(keys, ["first_name", "last_name", "first_name", "phone", "linkedin_url", "first_name"]);
});

test("nunca pisa un campo con valor y respeta los tipos excluidos", () => {
  const out = matchProfileToFields(PROFILE, [
    field({ label: "Email", value: "otro@x.com" }),
    field({ label: "Date of birth", inputType: "date" }),
    field({ label: "Email" })
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.value, "ana@correo.co");
});

test("no rellena datos personales en campos de OTRA entidad (empresa, escuela, referencias)", () => {
  const out = matchProfileToFields(PROFILE, [
    field({ label: "Company name" }),
    field({ label: "Reference email" }),
    field({ label: "Nombre de la empresa" }),
    field({ label: "Name" })
  ]);
  assert.deepEqual(out.map(m => m.key), ["full_name"], "solo el campo «Name» genérico se rellena");
});

test("<select>: resuelve la opción por etiqueta o valor y omite si no existe", () => {
  const options = [{ value: "", label: "Selecciona" }, { value: "CO", label: "Colombia" }, { value: "MX", label: "México" }];
  assert.equal(resolveOption(options, "colombia")?.value, "CO");
  assert.equal(resolveOption(options, "mx")?.value, "MX");
  assert.equal(resolveOption(options, "Perú"), null);

  const [hit] = matchProfileToFields(PROFILE, [field({ kind: "select", inputType: "", label: "País", hints: "country", options })]);
  assert.equal(hit?.value, "CO", "el valor de la coincidencia es el value de la <option>");
  assert.equal(matchProfileToFields({ current_country: "Perú" }, [field({ kind: "select", inputType: "", label: "Country", options })]).length, 0);
});

test("la lógica pura devuelve solo datos serializables (sin referencias al DOM)", () => {
  const out = matchProfileToFields(PROFILE, [field({ label: "Email" })]);
  assert.doesNotThrow(() => structuredClone(out));
});

test("detectOpenQuestions: pistas, campos largos, tipos y valores", () => {
  const found = detectOpenQuestions([
    field({ kind: "textarea", inputType: "", label: "Tell us about yourself" }),
    field({ label: "¿Por qué quieres trabajar aquí?" }),
    field({ label: "Experiencia relevante", maxLength: 500 }),
    field({ label: "Describe your role", inputType: "email" }),
    field({ label: "Why us?", value: "ya escrito" }),
    field({ label: "Nombre" }),
    field({ kind: "select", inputType: "", label: "Why?" }),
    field({ kind: "textarea", inputType: "", label: "", hints: "cover_letter" })
  ]);
  assert.deepEqual(found.map(q => q.question), ["Tell us about yourself", "¿Por qué quieres trabajar aquí?", "Experiencia relevante", "cover_letter"]);
});

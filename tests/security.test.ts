import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDotEnv, validateSupabaseConfig, resolveBuildEnv } from "../scripts/build-env.mjs";
import { describeError, redact } from "../src/shared/logger";
import { HirelyError } from "../src/shared/errors";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload: object) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.firma`;
const URL_OK = "https://abcdefgh.supabase.co";

test("el build acepta la clave anon pública y la publishable", () => {
  assert.deepEqual(validateSupabaseConfig({ url: URL_OK, anonKey: jwt({ role: "anon", ref: "abcdefgh" }) }), []);
  assert.deepEqual(validateSupabaseConfig({ url: URL_OK, anonKey: "sb_publishable_abc123" }), []);
});

test("el build RECHAZA service_role, claves secretas, marcadores y proyectos cruzados", () => {
  assert.match(validateSupabaseConfig({ url: URL_OK, anonKey: jwt({ role: "service_role" }) }).join(), /service_role/);
  assert.match(validateSupabaseConfig({ url: URL_OK, anonKey: "sb_secret_xyz" }).join(), /SECRETA/);
  assert.ok(validateSupabaseConfig({ url: URL_OK, anonKey: "PEGA_AQUI_TU_PUBLISHABLE_O_ANON_KEY" }).length);
  assert.ok(validateSupabaseConfig({ url: "https://TU-PROYECTO.supabase.co", anonKey: "sb_publishable_a" }).length);
  assert.ok(validateSupabaseConfig({ url: "http://abcdefgh.supabase.co", anonKey: "sb_publishable_a" }).length, "solo https");
  assert.ok(validateSupabaseConfig({ url: `${URL_OK}/`, anonKey: "sb_publishable_a" }).length, "sin barra final");
  assert.match(validateSupabaseConfig({ url: URL_OK, anonKey: jwt({ role: "anon", ref: "otro" }) }).join(), /otro/);
});

test("resolveBuildEnv: producción falla sin config; una clave secreta falla incluso en desarrollo", async () => {
  await assert.rejects(() => resolveBuildEnv({ production: true, cwd: "/nonexistent", env: {} }), /inválida/);
  const dev = await resolveBuildEnv({ production: false, cwd: "/nonexistent", env: {} });
  assert.equal(dev.url, "");
  assert.ok(dev.warnings.length);
  await assert.rejects(
    () => resolveBuildEnv({ production: false, cwd: "/nonexistent", env: { HIRELY_SUPABASE_URL: URL_OK, HIRELY_SUPABASE_ANON_KEY: jwt({ role: "service_role" }) } }),
    /inválida/
  );
  const ok = await resolveBuildEnv({ production: true, cwd: "/nonexistent", env: { HIRELY_SUPABASE_URL: URL_OK, HIRELY_SUPABASE_ANON_KEY: "sb_publishable_ok" } });
  assert.equal(ok.url, URL_OK);
});

test("parseDotEnv", () => {
  assert.deepEqual(parseDotEnv(`# c\nA=1\nB="dos"\n\nC='tres' \nsinigual`), { A: "1", B: "dos", C: "tres" });
});

test("redact() oculta cualquier dato personal, de sesión o de respuestas antes de loguear", () => {
  const out = redact({ email: "ana@x.co", first_name: "Ana", access_token: "abc", answer_text: "mi respuesta", count: 3, nested: { phone: "300", n: 1 }, list: [{ label: "x" }] });
  assert.deepEqual(out, { email: "[redacted]", first_name: "[redacted]", access_token: "[redacted]", answer_text: "[redacted]", count: 3, nested: { phone: "[redacted]", n: 1 }, list: [{ label: "[redacted]" }] });
});

test("describeError nunca incluye el mensaje (que podría contener datos del usuario)", () => {
  const err = new HirelyError("NETWORK", "mensaje con ana@x.co", { cause: new Error("secreto") });
  const described = describeError(err);
  assert.deepEqual(described, { name: "HirelyError", code: "NETWORK" });
  assert.doesNotMatch(JSON.stringify(described), /ana@x\.co|secreto/);
});

test("el código fuente no usa console.* fuera del logger ni embebe claves literales", () => {
  const files: string[] = [];
  const walk = (dir: string) => { for (const e of readdirSync(dir)) { const p = join(dir, e); statSync(p).isDirectory() ? walk(p) : /\.(ts|js|json|html)$/.test(p) && files.push(p); } };
  for (const dir of ["src", "public", "web-app"]) walk(dir);
  const files2 = files.filter(f => !f.includes("vendor"));
  assert.ok(files2.length > 10);
  for (const file of files2) {
    const code = readFileSync(file, "utf8");
    if (file.startsWith("src") && !file.endsWith("logger.ts")) assert.doesNotMatch(code, /\bconsole\./, `${file} usa console.* directamente: usa log.* de shared/logger`);
    assert.doesNotMatch(code, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, `${file} contiene un JWT literal`);
    assert.doesNotMatch(code, /sb_(secret|publishable)_[A-Za-z0-9]/, `${file} contiene una clave de Supabase literal`);
  }
});

test("manifest.json: CSP estricta de MV3, sin código remoto ni unsafe-*", () => {
  const manifest = JSON.parse(readFileSync("public/manifest.json", "utf8"));
  const csp: string = manifest.content_security_policy.extension_pages;
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-eval|unsafe-inline|\*(?!\.supabase\.co)(?=[;\s]|$)/);
  assert.equal(manifest.manifest_version, 3);
  const script = csp.split(";").find(d => d.trim().startsWith("script-src"))!;
  assert.doesNotMatch(script, /https?:/, "script-src no admite orígenes remotos");
  assert.equal(readFileSync("public/popup.html", "utf8").match(/<script[^>]*>/g)?.every(tag => /src="[^"h]/.test(tag) && !/https?:/.test(tag)), true, "popup.html solo carga scripts locales");
});

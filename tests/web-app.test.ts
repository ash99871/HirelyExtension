import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload: object) => `${b64({ alg: "HS256" })}.${b64(payload)}.firma`;

/** Carga index.html SIN scripts y ejecuta config + app.js contra un `supabase` falso. */
function boot(key: string) {
  const html = readFileSync("web-app/index.html", "utf8").replace(/<script[\s\S]*?<\/script>/g, "");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://hirely.example.com/" });
  const w = dom.window as unknown as Window & { eval(code: string): unknown } & Record<string, unknown>;
  let created = 0;
  w["supabase"] = { createClient: () => { created++; return { auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange() {} } }; } };
  w.eval(`window.HIRELY_CONFIG = { SUPABASE_URL: "https://abcdefgh.supabase.co", SUPABASE_PUBLISHABLE_KEY: ${JSON.stringify(key)} };`);
  w.eval(readFileSync("web-app/app.js", "utf8"));
  return { created, notice: dom.window.document.getElementById("notice")?.textContent ?? "" };
}

test("web-app: rechaza una clave service_role o sb_secret_ y NO crea el cliente de Supabase", () => {
  for (const key of [jwt({ role: "service_role" }), "sb_secret_abcdef"]) {
    const { created, notice } = boot(key);
    assert.equal(created, 0);
    assert.match(notice, /privilegios/);
    assert.doesNotMatch(notice, new RegExp(key.slice(0, 20)), "el aviso nunca repite la clave");
  }
});

test("web-app: con la clave anon / publishable sí inicializa el cliente", () => {
  assert.equal(boot(jwt({ role: "anon", ref: "abcdefgh" })).created, 1);
  assert.equal(boot("sb_publishable_abc123").created, 1);
});

test("web-app: config.js solo trae marcadores y index.html no carga código remoto ni inline", () => {
  const config = readFileSync("web-app/config.js", "utf8");
  assert.match(config, /TU-PROYECTO/);
  assert.match(config, /PEGA_AQUI/);
  const html = readFileSync("web-app/index.html", "utf8");
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? "";
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.doesNotMatch(csp, /unsafe-/);
  const scripts = html.match(/<script[^>]*>/g) ?? [];
  assert.ok(scripts.length >= 3);
  for (const tag of scripts) assert.match(tag, /src="(?!https?:|\/\/)[^"]+"/, `script no local: ${tag}`);
  assert.doesNotMatch(html, /cdn\.jsdelivr|unpkg/);
});

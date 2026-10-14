// Unifica los estáticos compartidos: una sola fuente de verdad (public/assets) y la librería
// de Supabase local (sin CDN) para que web-app/ se pueda publicar por sí sola.
import { copyFile, mkdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

export async function syncWebApp({ log = console.log } = {}) {
  await mkdir(`${root}web-app/assets`, { recursive: true });
  await copyFile(`${root}public/assets/hirely-logo.png`, `${root}web-app/assets/hirely-logo.png`);
  log("web-app/assets/hirely-logo.png ← public/assets/hirely-logo.png");

  const umd = `${root}node_modules/@supabase/supabase-js/dist/umd/supabase.js`;
  try {
    await stat(umd);
  } catch {
    log("AVISO: falta node_modules; ejecuta `npm install` para generar web-app/vendor/supabase.js");
    return;
  }
  await mkdir(`${root}web-app/vendor`, { recursive: true });
  await copyFile(umd, `${root}web-app/vendor/supabase.js`);
  const version = JSON.parse(await readFile(`${root}node_modules/@supabase/supabase-js/package.json`, "utf8")).version;
  const sha = createHash("sha384").update(await readFile(umd)).digest("base64");
  log(`web-app/vendor/supabase.js ← @supabase/supabase-js@${version} (sha384-${sha.slice(0, 16)}…)`);
}

if (import.meta.url === `file://${process.argv[1]}`) await syncWebApp();

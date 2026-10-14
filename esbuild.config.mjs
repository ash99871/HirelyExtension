import { build, context } from "esbuild";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { resolveBuildEnv } from "./scripts/build-env.mjs";
import { syncWebApp } from "./scripts/sync-web-app.mjs";

const args = new Set(process.argv.slice(2));
const production = !args.has("--development");
const watch = args.has("--watch");
const mode = production ? "production" : "development";

const { url, anonKey, warnings } = await resolveBuildEnv({ production });
for (const warning of warnings) console.warn(`⚠ ${warning}`);

// 1. dist/ limpio + estáticos (public/ es la única fuente: manifest, popup, assets).
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await cp("public", "dist", { recursive: true });

// La versión del manifest sale de package.json (una sola fuente de verdad).
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const manifest = JSON.parse(await readFile("public/manifest.json", "utf8"));
manifest.version = pkg.version;
if (!production) manifest.name = `${manifest.name} (dev)`;
await writeFile("dist/manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

// 2. Bundles.
/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: { popup: "src/popup/popup.ts", content: "src/content/content.ts" },
  outdir: "dist",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome114"],
  treeShaking: true,
  loader: { ".css": "text" },
  legalComments: "none",
  metafile: true,
  logLevel: "info",

  // Reemplazo de variables de entorno en tiempo de compilación.
  define: {
    __HIRELY_ENV__: JSON.stringify(mode),
    __DEV__: JSON.stringify(!production),
    __SUPABASE_URL__: JSON.stringify(url),
    __SUPABASE_ANON_KEY__: JSON.stringify(anonKey),
    "process.env.NODE_ENV": JSON.stringify(mode)
  },

  // Producción: minificado, sin sourcemaps y sin ningún console.* / debugger.
  // Desarrollo: legible y con sourcemaps externos (.map junto al bundle).
  minify: production,
  sourcemap: production ? false : "linked",
  drop: production ? ["console", "debugger"] : []
};

function report(result) {
  const rows = Object.entries(result.metafile.outputs)
    .filter(([file]) => file.endsWith(".js"))
    .map(([file, meta]) => `  ${file.padEnd(18)} ${(meta.bytes / 1024).toFixed(1).padStart(7)} KB`);
  console.log(`\nHirely (${mode}) → dist/\n${rows.join("\n")}`);
}

async function assertNoProductionLeaks() {
  const files = await readdir("dist", { recursive: true });
  const maps = files.filter(f => String(f).endsWith(".map"));
  if (maps.length) throw new Error(`Build de producción con sourcemaps: ${maps.join(", ")}`);
  for (const name of ["popup.js", "content.js"]) {
    const code = await readFile(`dist/${name}`, "utf8");
    if (/service_role|sb_secret_/.test(code)) throw new Error(`dist/${name} contiene una referencia a una clave secreta.`);
  }
}

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("Observando cambios en src/ (los estáticos de public/ requieren reiniciar)…");
} else {
  report(await build(options));
  if (production) await assertNoProductionLeaks();
  await syncWebApp();
}
await stat("dist/manifest.json");

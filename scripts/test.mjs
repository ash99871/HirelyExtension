// Ejecuta tests/*.test.ts con el runner nativo de Node (node:test). esbuild transpila el TS.
import { build } from "esbuild";
import { readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const names = (await readdir("tests")).filter(file => file.endsWith(".test.ts"));
await rm(".test-dist", { recursive: true, force: true });
await build({
  entryPoints: names.map(name => `tests/${name}`),
  outdir: ".test-dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["jsdom", "esbuild"],
  loader: { ".css": "text" },
  logLevel: "warning",
  define: {
    __DEV__: "false",
    __HIRELY_ENV__: '"production"',
    __SUPABASE_URL__: '"https://testproj.supabase.co"',
    __SUPABASE_ANON_KEY__: '"anon-test-key"'
  }
});
const files = names.map(name => `.test-dist/${name.replace(/\.ts$/, ".mjs")}`);
const result = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);

/**
 * Constantes reemplazadas en tiempo de compilación por esbuild (`define`).
 * Ver esbuild.config.mjs y scripts/build-env.mjs.
 */
declare const __HIRELY_ENV__: "development" | "production";
/** `true` solo en builds de desarrollo; en producción se elimina el código muerto. */
declare const __DEV__: boolean;
declare const __SUPABASE_URL__: string;
declare const __SUPABASE_ANON_KEY__: string;

/** Los .css se importan como texto (loader "text") para inyectarlos en el Shadow DOM. */
declare module "*.css" {
  const css: string;
  export default css;
}

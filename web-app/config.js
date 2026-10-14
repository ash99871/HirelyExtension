// Configuración PÚBLICA de Supabase para la web.
//   · SUPABASE_URL: Project URL (https://<ref>.supabase.co).
//   · SUPABASE_PUBLISHABLE_KEY: la clave publishable / anon. Es pública por diseño: la seguridad
//     real la imponen las políticas Row Level Security (RLS) de Postgres.
// NUNCA pegues aquí una service_role key ni una sb_secret_*: app.js se niega a arrancar si la detecta,
// pero un archivo estático publicado con una clave secreta ya la habría expuesto a cualquiera.
window.HIRELY_CONFIG = {
  SUPABASE_URL: "https://TU-PROYECTO.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "PEGA_AQUI_TU_PUBLISHABLE_O_ANON_KEY"
};

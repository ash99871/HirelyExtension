# Hirely Browser Extension — TypeScript v2.1

Extensión de Chrome (Manifest V3) para Hirely. Usa el mismo proyecto Supabase que la aplicación Lovable. No modifica la aplicación web existente y no utiliza `profile_versions`.

## Qué hace

- Inicio/cierre de sesión con Supabase Auth.
- Lee tu perfil (`public.profiles`) y rellena campos de formularios por etiqueta, `aria-label`, `aria-labelledby`, placeholder, `name` y `autocomplete` (ES/EN).
- Detecta preguntas abiertas y sugiere respuestas guardadas (similitud léxica local, sin IA).
- Panel sobre la página (aislado con Shadow DOM) para revisar, insertar o guardar respuestas. **Nunca envía el formulario.**
- Gestión de respuestas guardadas desde el popup.

## Estructura

```
public/                 Estáticos de la extensión (única fuente): manifest.json, popup.html/css, assets/
src/
  shared/               Lógica compartida
    types.ts · text-similarity.ts · field-mapping.ts · question-detection.ts · question-matching.ts
                        ← PURAS: sin DOM ni `chrome` (el compilador lo exige, ver "Arquitectura")
    errors.ts · http.ts · jwt.ts · logger.ts · config.ts
    storage.ts · auth-http.ts · session.ts
    supabase.ts         ← cliente de datos + wrapper estándar de peticiones
    auth-service.ts · profile-service.ts · answers-service.ts
  content/              Todo lo que toca la página
    content.ts          orquestador (escanear → lógica pura → llenar → UI)
    dom-fields.ts       escáner DOM y llenado + simulación de eventos React/Angular/Vue
    assistant-ui.ts/.css  botón y panel en Shadow DOM
  popup/popup.ts
scripts/                build-env.mjs · sync-web-app.mjs · test.mjs
tests/                  50 tests (node:test + jsdom)
sql/                    saved_answers.sql · verify_rls.sql
web-app/                Web independiente (ver web-app/README.md)
dist/                   ← GENERADO: es la extensión lista para cargar en Chrome
```

## Configuración

### 1. Variables de entorno (en tiempo de compilación)

```bash
cp .env.example .env
```

Rellena `HIRELY_SUPABASE_URL` (`https://<ref>.supabase.co`) y `HIRELY_SUPABASE_ANON_KEY` (clave **anon / publishable**). El build las inyecta en `popup.js` y `content.js` y **aborta** si:

- falta alguna en producción,
- la clave es `service_role` o `sb_secret_*`,
- la clave pertenece a otro proyecto que la URL.

> Antes, `config.js` solo se cargaba en el popup, por lo que el content script nunca recibía la configuración. Con la inyección en build funciona en ambos. Ya no existe `config.js` en la raíz.

### 2. Base de datos

En Supabase → SQL Editor ejecuta `sql/saved_answers.sql`. Después ejecuta `sql/verify_rls.sql` y comprueba que **RLS está activo en `profiles` y `saved_answers`** y que las políticas están limitadas a `authenticated` con `auth.uid() = user_id`. La clave anon es pública: lo único que protege los datos es RLS.

### 3. Compilar y cargar

Requiere Node.js 20+.

```bash
npm install
npm run check      # typecheck (3 configuraciones) + 50 tests
npm run build      # producción → dist/
```

En Chrome: `chrome://extensions` → **Modo de desarrollador** → **Cargar descomprimida** → elige la carpeta **`dist/`** (no la raíz). Recarga las pestañas ya abiertas.

| Comando | Qué hace |
|---|---|
| `npm run build` | Producción: minificado, sin sourcemaps, sin ningún `console.*` |
| `npm run build:dev` | Desarrollo: legible, sourcemaps, logs redactados, nombre «(dev)» |
| `npm run watch` | Desarrollo con recompilación al guardar `src/` |
| `npm run build:web` | Copia el logo y la librería de Supabase a `web-app/` |
| `npm run typecheck` | `tsc` ×3: principal, módulos puros (sin DOM) y tests |
| `npm test` | Suite de tests |

## Arquitectura

**Lógica de negocio ↔ DOM.** `field-mapping.ts` y `question-detection.ts` reciben `FieldDescriptor[]` (datos planos y serializables) y devuelven `FieldMatch[]` / `DetectedQuestion[]`. Nunca ven un `Element`. `src/content/dom-fields.ts` es el único sitio que lee elementos (escaneo) y escribe en ellos (llenado). `tsconfig.pure.json` compila los módulos puros **sin la librería DOM**: si alguien referencia `document` o `HTMLElement` en ellos, `npm run typecheck` falla.

**Llenado compatible con frameworks.** Se escribe con el setter del *prototype* (React instala un rastreador en la instancia y, si se asigna `el.value = x`, ignora el cambio) y se disparan `input` → `change` → `blur` → `focusout`. Nunca se pisa un campo con contenido; "Usar respuesta" (acción explícita) sí puede sustituir.

**Red y sesión.** Todas las peticiones pasan por `authenticatedRequest` (`shared/supabase.ts`):

- Solo lanza `HirelyError` con `code` estable (`NETWORK`, `AUTH_EXPIRED`, `MISSING_TABLE`, `EXTENSION_INVALIDATED`…) y mensaje en español apto para el usuario.
- Refresca el token *antes* de que caduque, o tras un 401, y reintenta una vez. Peticiones concurrentes comparten un único refresh (los refresh tokens de Supabase rotan y son de un solo uso).
- Un fallo de red **nunca** cierra la sesión; solo un rechazo definitivo del servidor lo hace.
- Lecturas y borrados se reintentan ante fallos transitorios; las inserciones **nunca** (evita duplicados).
- Detecta «Extension context invalidated» (content scripts huérfanos tras recargar la extensión).

**Shadow DOM.** El botón flotante y el panel viven en un shadow root `closed`. Los estilos se aplican con `adoptedStyleSheets`, que a diferencia de un `<style>` inline no bloquea un CSP estricto del sitio. Los eventos de teclado y clic del panel no se propagan a la página (ni disparan sus atajos ni cierran sus modales).

**Rendimiento.** Alias de campos precompilados, índice de etiquetas `label[for]` (O(n) en vez de O(n²)), tokens de respuestas calculados una vez, escaneo y matching troceados que ceden el hilo (`scheduler.yield()` / `setTimeout`). No se usa Web Worker: un content script comparte el origen de la página y no puede crear un Worker desde un archivo de la extensión (el workaround con `blob:` puede ser bloqueado por el CSP del sitio, y fallaría en silencio en esas páginas) y el cómputo, O(preguntas × respuestas) sobre conjuntos pequeños, no lo justifica. Como el matching es puro, moverlo a un Worker/service worker en el futuro sería un cambio local.

## Seguridad y privacidad

- Solo clave pública; el build rechaza `service_role`/`sb_secret_*` y comprueba que `dist/` no contenga referencias a ellas.
- CSP estricta en el manifest: `script-src 'self'`, `object-src 'none'`, `default-src 'none'`, `connect-src https://*.supabase.co`. Solo se permiten hojas de estilo y tipografías de Google Fonts (`popup.css` las importa). Para un dominio propio de Supabase, edita `host_permissions` y `connect-src` en `public/manifest.json`.
- Producción: `drop: ["console", "debugger"]` y `__DEV__ = false`. En desarrollo, el logger redacta correos, tokens, perfil y respuestas, y solo registra conteos y códigos de error.
- De `profiles` solo se conservan en memoria los campos que se usan para autocompletar; al cerrar el panel se descartan elementos y respuestas.
- Se guardan solo `id` y `email` del usuario en `chrome.storage.local`, no el objeto completo de GoTrue.
- No se rellenan campos ocultos (`display:none`, `aria-hidden`) ni de «otras entidades» («Company name», «Reference email»…).
- Se usa `fetch` directo contra GoTrue y `@supabase/postgrest-js` en lugar de `@supabase/supabase-js`.

## Tamaño del bundle

| | Original (sin minificar) | Ahora, desarrollo | Ahora, producción |
|---|---|---|---|
| `content.js` (se inyecta en cada página) | 805 KB | 161 KB | **42 KB** |
| `popup.js` | 795 KB | 140 KB | **30 KB** |

## Límites conocidos

- **No probado en un Chrome real ni contra tu Supabase.** Se verificó con 50 tests (incluido el bundle de producción ejecutado sobre jsdom con `fetch` simulado). Prueba el flujo completo en un formulario real.
- Un sitio puede ignorar eventos sintéticos (`isTrusted: false`), y los componentes personalizados (selects de React-Select, `contenteditable`, formularios en iframes o shadow DOM de la página) no se detectan.
- Las peticiones del content script salen con el origen de la página (aplica CORS). Supabase lo permite; si algún sitio con CSP muy estricto las bloqueara, habría que moverlas a un service worker.
- El content script se inyecta en todas las páginas `http(s)` (muestra el botón «H» en cada una). Una alternativa más restrictiva es `activeTab` + `chrome.scripting` (inyectar solo al pulsar el icono), a costa de perder el botón flotante.
- La extensión no tiene iconos: añade PNG de 16/48/128 px en `public/icons/` y decláralos en `public/manifest.json` (`icons`).
- Si ya existe una tabla `saved_answers`, revisa sus columnas antes de ejecutar la migración.

´´´
Hirely/
  extension/
    dist/
    public/
    src/
      popup/
      shared/
      content/
    scripts/
    web-app/
  webLovable/
    .lovable/
    drizzle/
    extension/
    public/
    src/
      assets/
      components/
      hooks/
      integrations/
        lovable/
        supabase/
      lib/
      routes/
    supabase/

´´´
# Hirely Browser Extension — TypeScript v2.1

Extensión de Chrome/Edge/Safari (Manifest V3) para Hirely. Usa el mismo proyecto Supabase que la aplicación Lovable. No modifica la aplicación web existente y no utiliza `profile_versions`.

URL de creación de cuenta: https://isaparras23-hirely-web-hirely-09.hirelyeafit.workers.dev/


## Qué hace

- Inicio/cierre de sesión con Supabase Auth.
- Lee tu perfil (`public.profiles`) y rellena campos de formularios por etiqueta, `aria-label`, `aria-labelledby`, placeholder, `name` y `autocomplete` (ES/EN).
- **Pide autorización antes de llenar**: muestra «Encontramos esta información para estos campos» con cada dato, y solo llena lo que la persona deja marcado (ver «Autorización»).
- **Pregunta lo que no sabe**: todo campo vacío del formulario (texto, listas, radios, casillas, botones de opción y los desplegables propios de Magneto) aparece en «Necesitamos tu respuesta» y se responde desde el panel (ver «Formulario completo»).
- **Revisa que no quede nada vacío**: después de llenar vuelve a mirar el formulario, pide lo obligatorio que falte y termina con un resumen.
- **Recuerda las respuestas** (si la persona quiere) en `saved_answers` para proponerlas la próxima vez. Nunca los datos sensibles.
- Avisa «Formulario detectado · N campos» junto al botón «H» cuando aparece un formulario con campos vacíos.
- Panel sobre la página (aislado con Shadow DOM). **Nunca envía el formulario** ni pulsa «Guardar» o «Siguiente».
- Gestión de respuestas guardadas desde el popup.

## Estructura

```
public/                 Estáticos de la extensión (única fuente): manifest.json, popup.html/css, assets/
src/
  shared/               Lógica compartida
    types.ts · text-similarity.ts · field-mapping.ts · question-detection.ts · question-matching.ts
    complementary-data.ts · form-questions.ts
                        ← PURAS: sin DOM ni `chrome` (el compilador lo exige, ver "Arquitectura")
    errors.ts · http.ts · jwt.ts · logger.ts · config.ts
    storage.ts · auth-http.ts · session.ts
    supabase.ts         ← cliente de datos + wrapper estándar de peticiones
    auth-service.ts · profile-service.ts · answers-service.ts
  content/              Todo lo que toca la página
    content.ts          orquestador (leer formulario → revisión → llenar → revisar lo vacío → resumen)
    dom-fields.ts       escáner DOM y llenado + simulación de eventos React/Angular/Vue + fechas de 8 casillas
    dom-actions.ts      acciones compartidas: clic, escribir, abrir/cerrar listas, ¿está marcado?
    page-questions.ts   todos los campos vacíos del formulario abierto → preguntas; responderlas
    complementary-form.ts  modal de datos complementarios de Magneto (preferencias)
    assistant-ui.ts/.css  botón, aviso «Formulario detectado» y panel en Shadow DOM
  popup/popup.ts
scripts/                build-env.mjs · sync-web-app.mjs · test.mjs
tests/                  107 tests (node:test + jsdom)
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
npm run check      # typecheck (3 configuraciones) + 107 tests
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

**Llenado compatible con frameworks.** Se escribe con el setter del *prototype* (React instala un rastreador en la instancia y, si se asigna `el.value = x`, ignora el cambio) y se disparan `input` → `change` → `blur` → `focusout`. Nunca se pisa un campo con contenido.

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
| `content.js` (se inyecta en las páginas de Magneto) | 805 KB | — | **88 KB** |
| `popup.js` | 795 KB | 140 KB | **30 KB** |

## Autorización

Nada se escribe en la página sin permiso. Al pulsar «H» (o «Autocompletar» en el popup):

1. **Planear (solo lectura).** `planComplementaryModal` (modal de Magneto) y `matchFieldsToValues` (resto de la página) calculan qué se llenaría. No abren listas, no escriben, no hacen clic.
2. **Preguntar.** El panel muestra «Encontramos esta información para estos campos»: una fila por dato con su casilla (marcada por defecto), el valor editable si es texto libre, «Marcar todos / Quitar todos», **Autorizar y llenar (n)** y **Cancelar**. En un `<select>` se muestra el texto de la opción («Colombia»), no su `value` («CO»), y no se edita.
3. **Llenar solo lo autorizado**, con el valor que la persona dejó. Lo desmarcado no se toca.

La fecha de nacimiento de Magneto (8 casillas de un dígito) aparece como una sola fila, «Fecha de nacimiento: DD/MM/AAAA», y también se puede quitar o corregir.

Cancelar o cerrar el panel equivale a no autorizar: no se llena nada.

Para cualquier llenado nuevo (por ejemplo, el formulario de crear cuenta en Magneto), usa la misma puerta: arma la lista y llama a `ui.requestReview({ found, ask })` **antes** de escribir. Resuelve con lo autorizado (`approvals`: id + valor final), lo respondido (`answers`) y si se debe recordar, o con `null`.

## Formulario completo

La idea: que todo se haga desde el panel y la persona no tenga que buscar si quedó un campo vacío.

1. **Qué formulario.** `findFormScope` toma la ventana de encima (Magneto no usa `role="dialog"`: sus ventanas son `div.mg_modal_magneto-ui-modal`); si no hay ninguna, la página sin encabezado, menús ni buscadores.
2. **Qué falta.** `collectQuestions` convierte en pregunta todo campo vacío que no se llena desde el perfil:

   | En la página | En el panel |
   |---|---|
   | texto, correo, teléfono, número; áreas de texto | caja de texto (área de texto para respuestas largas) |
   | `<input type="date">` y fechas de 8 casillas de Magneto | texto DD/MM/AAAA |
   | `<select>`, radios (con o sin `name`), `role="radio"` | botones de opción (más de 8 opciones: lista) |
   | casillas sueltas / grupos de casillas | «Marcar esta casilla» / varias opciones |
   | botones de Magneto (estado civil, disponibilidad) y tarjetas (modalidad) | botones de opción (varias si es disponibilidad, modalidad, idiomas…) |
   | desplegables de Magneto (select2) | se abren, se leen sus opciones y se cierran con un clic fuera, **sin elegir nada**; si solo muestran un buscador (Cargo, Ciudad), se escribe y se elige la sugerencia más parecida |

   La pregunta es la etiqueta del campo o el texto que va justo antes. En los desplegables de Magneto gana el nombre real del campo («Cargo equivalente»), salvo que sea una instrucción («Selecciona un género»). Las preguntas repetidas llevan su bloque: «Cargo equivalente · Control · App de organización personal». Los archivos no se suben: el resumen dice «Adjunta tú: …». Nunca se tocan contraseñas.
3. **Propuestas.** Si el perfil tiene el dato (p. ej. «País» en una lista), la pregunta pasa a «Encontramos…». Si hay una respuesta guardada muy parecida, ya viene escrita; si se parece menos, se ofrece con «Usar mi respuesta guardada».
4. **Revisión final.** Tras llenar se vuelve a leer el formulario: se pide otra vez lo que falló, lo obligatorio («*») y los campos nuevos que aparecieron (p. ej. al responder «Sí»), en una pantalla «Faltan N campos» con «Terminar». Lo opcional que la persona dejó en blanco no se vuelve a pedir: sale en el resumen final.
5. **Recordar.** «Recordar mis respuestas para la próxima vez» (marcado por defecto) guarda cada respuesta nueva en `saved_answers` (categoría «Formulario»), sin duplicados.

**Datos sensibles** (discapacidad, orientación sexual, etnia, salud, religión…, `isSensitiveQuestion`): se preguntan, pero nunca se proponen desde el perfil ni se guardan.

**Aviso «Formulario detectado».** Un `MutationObserver` (con espera de 0,9 s) cuenta los campos vacíos sin abrir nada y muestra «Formulario detectado · N campos» junto al botón «H». En la página completa solo cuentan los campos dentro de un `<form>`, para no avisar por buscadores o filtros.

## Magneto: datos complementarios

Al pulsar el botón de la extensión en el modal «Completa los siguientes datos para terminar tu aplicación a la vacante», se rellenan los campos con datos de tu perfil de Hirely.

| Campo del modal | Dato en Supabase | Cómo se usa |
|---|---|---|
| Sector o sectores laborales (lista cerrada) | `profiles.desired_area` (texto libre) | Coincidencia exacta; si no existe, se elige la opción con más palabras en común y se marca para revisar. Si no hay coincidencia clara, no se elige nada. |
| Cargo | `profiles.desired_position` | Se escribe y se elige la sugerencia. Igual que Sector: coincidencia exacta primero; si no existe, la opción con más palabras en común, marcada para revisar. |
| Último nivel de estudios | `education.level`, `education.degree`, `education.program` | Se clasifica por cómo empieza el título («Tecnólogo/a en…», «Técnico/a en…», «Bachiller…»; lo que viene después de «en» no cambia el tipo): primaria → «Básica primaria»; especialización, maestría, doctorado, MBA o una especialidad médica (cardiología, cirugía general, medicina interna…) → «Especialización/Maestría»; tecnólogo, técnico o bachiller → su nombre; cualquier otro título → «Profesional». Si hay varios estudios, gana el más alto. |
| Salario | `profiles.salary_expectation` | Solo dígitos: «2000000.00» → 2000000 |
| Modalidad: Remoto / Híbrido | `profiles.work_modality` (desplegable) | Solo Remoto e Híbrido; «Presencial» se ignora |
| Disponible para viajar / cambio de domicilio | `willing_to_travel`, `willing_to_relocate` | Si es verdadero |
| Tiempo completo, Medio tiempo, Por horas, Jornada diurna… | `work_schedule` y `schedule_availability` (texto libre) | Por palabras clave; «Inmediata» no produce ninguna opción |

Reglas:

- Lo que no coincide claramente aparece en el panel como «Revisar». La extensión no adivina.
- Sector y Cargo usan la misma lógica: coincidencia exacta primero, y si no existe, la opción con más palabras en común. Antes solo Sector tenía ese respaldo; Cargo se rendía si la sugerencia no empezaba exactamente por el texto escrito, por ejemplo si Magneto reordenaba las palabras.
- Magneto pone los puntos de miles solo, así que el salario se envía sin separadores.
- La discapacidad nunca se rellena: la responde siempre la persona.
- Magneto usa desplegables «select2»: un botón visible con el texto y un `<input>` oculto con el nombre real del campo. La extensión abre el botón, nunca el `<input>` oculto.
- Las tarjetas de modalidad marcadas tienen la clase `…--selected___xxx`. Si ya están marcadas, no se vuelven a pulsar.
- Pendiente: la ciudad («¿Dónde quieres trabajar?») necesita saber qué columna de Hirely usar (`preferred_work_locations.city` o `current_city`) y cómo se escriben las ciudades en la lista de Magneto.
- Pendiente: confirmar las opciones exactas del desplegable de nivel de estudios de Magneto («Bachiller», «Técnico», «Tecnólogo», «Profesional»). Si el texto no coincide, aparece como «Revisar».


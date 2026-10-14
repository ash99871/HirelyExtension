# Hirely Web independiente

Interfaz web adaptable para escritorio y móvil, separada del popup de la extensión de Chrome. Incluye inicio de sesión con Supabase, consulta de los campos existentes del perfil y CRUD de respuestas guardadas. No usa `profile_versions`.

## Configuración
0. Desde la raíz del proyecto ejecuta `npm install && npm run build:web`. Esto genera `web-app/assets/hirely-logo.png` (copia de `public/assets/`, única fuente) y `web-app/vendor/supabase.js` (la librería de Supabase, fijada por `package-lock.json`). Ambos están en `.gitignore`: no se versionan duplicados. Si publicas solo la carpeta `web-app/`, sube también esos dos archivos generados.
1. Abre `config.js`.
2. Sustituye `SUPABASE_URL` y `SUPABASE_PUBLISHABLE_KEY` por la URL y la publishable key (o anon key) del mismo proyecto Supabase que usa Hirely/Lovable. **No uses `service_role` ni una secret key en el navegador:** `app.js` se niega a iniciar si detecta una clave con privilegios (pero un archivo ya publicado la habría expuesto; si ocurre, rota la clave en Supabase).
3. Verifica que Supabase Auth permita el origen/dominio desde el que publiques el sitio y que las políticas RLS de `profiles` y `saved_answers` limiten el acceso al usuario autenticado.
4. Sirve esta carpeta con un servidor estático o publícala en un hosting estático. Para desarrollo local puedes usar VS Code Live Server o `python -m http.server 8080` desde esta carpeta y abrir `http://localhost:8080`. Es preferible usar localhost/HTTPS en lugar de `file://`.

## Estructura
- `index.html`: interfaz y vistas.
- `styles.css`: estilos responsivos para escritorio, tablet y celular.
- `app.js`: sesión, lectura de perfil y operaciones CRUD de respuestas.
- `config.js`: configuración pública de Supabase.
- `assets/hirely-logo.png` y `vendor/supabase.js`: generados por `npm run build:web` (ver Configuración).

## Seguridad
- Sin código remoto: la librería de Supabase se sirve desde `vendor/` (antes se cargaba desde un CDN sin versión fija ni SRI). `index.html` incluye una CSP (`script-src 'self'`, `connect-src 'self' https://*.supabase.co`, sin `unsafe-*`).
- Una etiqueta `<meta>` no puede aplicar `frame-ancestors`. En tu hosting añade como cabeceras HTTP: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` y `Content-Security-Policy: frame-ancestors 'none'` para impedir que otro sitio incruste la página.
- RLS en `profiles` y `saved_answers` es lo que protege los datos: audítalo con `sql/verify_rls.sql`.

## Notas de esquema
- Perfil: consulta `profiles` filtrando por `user_id`; muestra dinámicamente las columnas con valor. No intenta modificar el perfil porque el esquema exacto de campos editables puede variar.
- Respuestas: espera la tabla `saved_answers` con `question_text`, `answer_text`, `category`, `context`, `user_id`, `id` y marcas de tiempo, como en el SQL incluido en la carpeta raíz `sql/`.
- La web y la extensión pueden compartir el mismo proyecto Supabase, pero deben configurarse con la misma URL/key pública.

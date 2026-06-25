# mambo · App de Pipeline (piloto Perú)

App web responsiva **mobile-first** para que los gerentes comerciales actualicen su
pipeline en segundos, con una mano, desde el celular. Reemplaza la fricción de editar
en Pipedrive/CRM de escritorio.

Construida según el handoff técnico (PRD): foundations de marca, especificación
funcional y modelo de datos. **Fuente de verdad: Supabase** (base compartida en tiempo
real). Sin login: cada partner elige quién es y solo edita sus negocios.

## Estructura

```
apps/pipeline/
├── index.html              # estructura de la app (pantallas 01–04 + ¿quién eres?)
├── styles.css              # estilos de la app (importa colors_and_type.css)
├── colors_and_type.css     # foundations de marca: color, tipografía, tokens
├── data.js                 # SEED_DEALS (fallback/demo) + catálogos + OWNERS
├── supabase.js             # capa de datos: config, lectura, escritura, realtime
├── app.js                  # lógica: filtros, edición, perdido, export, identidad
├── api/config.js           # serverless (Vercel): entrega URL+anon key desde env vars
├── config.example.js       # template de config local (opcional, NO se sube)
├── db/schema.sql           # DDL: tabla deals + updated_at + RLS + realtime
├── db/seed.sql             # carga inicial: 131 negocios (pegar en Supabase)
├── manifest.webmanifest    # PWA: nombre, íconos, display standalone, colores
├── service-worker.js       # PWA: precache del shell (no cachea Supabase ni /api)
├── icons/                  # íconos PWA (192, 512, 512-maskable, apple-touch 180)
└── vercel.json             # config de deploy estático
```

## Pantallas

1. **Lista de negocios** — cards (org, título, etapa, monto, prob, avatar);
   filtros por dueño, etapa (chips) y búsqueda; toggle ver/ocultar perdidos;
   header con contador de **pendientes** (de confirmar en Pipedrive) + total "en juego".
2. **Detalle / edición** — tags read-only (vertical, tipo de cliente, industria,
   origen); editable: etapa, monto, probabilidad, comentario; barra de guardado sticky.
3. **Resultado** — En curso / Ganado / Perdido (perdido exige motivo).

### Contador "Cambios" = pendientes de confirmar en Pipedrive
Al guardar, el cambio va a Supabase y se intenta sincronizar con Pipedrive.
- Si Pipedrive **confirma** → el negocio sale del contador (0 = todo sincronizado).
- Si **no** se confirma (sin `pipedrive_id`, monto bloqueado por productos, error de
  red, modo prueba/dry-run, nota no creada) → el negocio queda **pendiente**, suma al
  contador y se marca con "⏳ pendiente" en la card. Reintentar el guardado, una vez
  confirmado, lo saca del contador.

## Ejecutar en local

Es un sitio estático: sirve la carpeta con cualquier servidor HTTP.

```bash
# Node
npx serve apps/pipeline -l 4321

# o Python
python -m http.server 4321 -d apps/pipeline
```

Luego abrir <http://localhost:4321>. En el repo se incluye además
`.claude/static-server.ps1` (servidor estático en PowerShell, sin dependencias) usado
para el preview en Windows.

## Base de datos (Supabase)

La fuente de verdad es una tabla `deals` en **Supabase**. La app la lee al iniciar,
escribe cada cambio y usa **Supabase Realtime** para reflejar en vivo lo que guardan
otros partners. `data.js` (`SEED_DEALS`) queda solo como **fallback "modo demo"** (si
Supabase no está configurado) y como base para generar `db/seed.sql`.

**Sin login.** La app usa la *clave anónima* (pública por diseño) y políticas RLS que
permiten leer/escribir a cualquiera con esa clave. La regla "cada partner solo edita
lo suyo" es una **barrera de interfaz, no seguridad real**. Suficiente para un piloto
interno; si luego se quiere seguridad real, se agrega login.

### Configuración (sin claves en el código)

- En producción, la URL y la anon key se entregan al cliente vía la función serverless
  `api/config.js`, que las lee de las **variables de entorno de Vercel**. Nada de claves
  en el repo.
- En local (opcional), copia `config.example.js` → `config.js` (ignorado por git).

### Identidad y permisos

- Al abrir, la app pide **"¿Quién eres?"** y guarda la elección en `localStorage`.
- Todos ven todos los negocios; cada quien solo **edita los suyos** (los demás salen en
  solo lectura, con candado 🔒). Se puede cambiar de partner tocando el chip del header.

> Nota: el flujo de **Exportar/CSV/Copiar resumen** se eliminó. Ya no se necesita: los
> cambios se sincronizan directo a Pipedrive y el contador muestra lo que quede pendiente.

## PWA — instalable en iPhone y Android

La app es una **Progressive Web App** instalable que se abre en pantalla completa
(sin barra del navegador), con ícono propio en la pantalla de inicio.

- **Android (Chrome):** al abrir la URL desplegada, Chrome ofrece **"Instalar app"**
  (también desde el menú ⋮ → *Instalar aplicación*). Requisitos cumplidos: HTTPS,
  `manifest.webmanifest` (name, short_name, start_url, `display: standalone`, íconos
  192 + 512 + maskable) y un service worker con manejador `fetch`.
- **iPhone (Safari):** botón **Compartir → "Agregar a pantalla de inicio"**. Usa el
  `apple-touch-icon` de 180×180 y abre en modo standalone.

Probado en local (manifest con MIME `application/manifest+json`, SW activo en scope
`/`, app shell + fuentes cacheadas para offline). **Importante en Vercel:** las rutas
del manifest/íconos/SW son absolutas (`/manifest.webmanifest`, `/icons/…`,
`/service-worker.js`), por lo que el **Root Directory** del proyecto debe ser
`apps/pipeline` (ver sección Deploy).

> Nota: no se usa Vite. Por eso los archivos PWA viven en la raíz servida
> (`apps/pipeline/`) en lugar de una carpeta `public/` — equivalen a lo mismo en un
> sitio sin bundler.

## Puesta en marcha (pasos manuales)

### A) En Supabase (una vez)
1. Crea un proyecto en <https://supabase.com>.
2. **SQL Editor → New query** → pega y corre `db/schema.sql` (crea la tabla, el
   `updated_at` automático, las políticas RLS y activa Realtime).
3. **SQL Editor → New query** → pega y corre `db/seed.sql` (carga los 131 negocios).
4. **Project Settings → API** → copia el **Project URL** y la **anon public key**.

### B) En Vercel (una vez)
En el proyecto → **Settings → Environment Variables**, crea estas dos (para
Production y Preview):

| Nombre              | Valor                          |
|---------------------|--------------------------------|
| `SUPABASE_URL`      | el Project URL de Supabase     |
| `SUPABASE_ANON_KEY` | la anon public key de Supabase |

Luego **Deployments → Redeploy**. (Mantén **Root Directory = `apps/pipeline`**.)

> No llevan prefijo `NEXT_PUBLIC_`/`VITE_` porque no hay framework: las lee la función
> `api/config.js` del lado del servidor y se las pasa al cliente. **Nunca** pongas aquí
> la `service_role` key.

## Agregar negocios nuevos desde Pipedrive (a futuro)

Ahora la fuente de verdad es Supabase. Para sumar negocios nuevos (en pasos simples):

1. En Pipedrive, exporta los negocios a **CSV** (como hiciste antes).
2. Entra a tu proyecto de Supabase → menú **Table Editor** → tabla **`deals`**.
3. Botón **Insert → Import data from CSV** y sube tu archivo.
4. Asocia cada columna del CSV con la columna de la tabla (organización→`org`,
   título→`title`, valor→`amount`, propietario→`owner`, etapa→`stage`, etc.).
   - En `stage` usa el id corto: `target`, `primera`, `contacto`, `propuesta`,
     `cierre`, `nurturing`.
5. Confirma. Listo: los negocios aparecen para todos, y si alguien tiene la app
   abierta los verá entrar en vivo.

> Alternativa rápida para una sola fila: en **Table Editor → Insert → Insert row**,
> llenas los campos a mano y guardas.

## Sincronización con Pipedrive (una vía: app → Pipedrive)

Al guardar un cambio, la app escribe en Pipedrive vía la función serverless
`api/pipedrive-sync.js` (el token vive solo en el servidor, nunca en el navegador).

- **Solo pipeline 1.** Antes de escribir, valida (GET) que el deal pertenezca al
  `pipeline_id = 1`; si no, no escribe y lo registra.
- **Solo deals con `pipedrive_id`.** Los que no lo tienen se guardan en la app pero
  no se sincronizan, y se marcan con ⚠ "sin Pipedrive".
- **Solo campos que cambiaron** (etapa→`stage_id`, monto→`value`, prob→`probability`,
  ganado→`status:won`, perdido→`status:lost`+`lost_reason`). Un guardado con varios
  campos los manda **todos juntos** en un solo PUT, y confirma cada uno (incluido
  `value`: si el negocio usa **productos**, Pipedrive bloquea el monto y la app avisa
  "Pipedrive sin confirmar").
- **Comentario → NOTA**: si el comentario cambió, se crea como **nota nueva** del
  negocio (`POST /notes` con `deal_id`), dejando historial. Mismas reglas
  (server-side, pipeline 1, modo prueba).
- **Pipedrive primero, luego la app**: si Pipedrive rechaza, no se guarda en la app
  (no quedan estados contradictorios). Cada intento se registra (Vercel → Logs).

Mapeo de etapas (app → `stage_id` de Pipedrive, pipeline 1):

| App                       | stage_id |
|---------------------------|----------|
| Target                    | 1        |
| Contacto establecido      | 2        |
| Primera reunión           | 16       |
| Presentación de propuesta | 52       |
| Follow-up y cierre        | 55       |
| Nurturing                 | 11       |

### Variables de entorno en Vercel
| Nombre | Para qué |
|---|---|
| `PIPEDRIVE_API_TOKEN` | token de API (ya creado) |
| `PIPEDRIVE_TEST_DEAL_IDS` | (prueba) IDs separados por coma que SÍ se escriben de verdad; el resto se simula |
| `PIPEDRIVE_SYNC_ENABLED` | `true` = escribir de verdad para TODOS (solo si NO hay TEST_DEAL_IDS) |

Sin las dos últimas → **todo se simula** (dry-run), no escribe nada. Modo seguro por defecto.

### Resultado del negocio
- **Perdido**: disponible en todas las etapas; exige uno de 3 motivos exactos
  ("Escogieron otro proveedor", "Desinterés (dejaron de contestar)",
  "Falta de presupuesto") que se envían como `lost_reason`.
- **Ganado**: solo desde "Presentación de propuesta" en adelante; envía `status:won`.

## Deploy

Estático + cliente. **Vercel** con **Root Directory = `apps/pipeline`** y las dos
variables de entorno de arriba.

```bash
cd apps/pipeline
vercel deploy
```

## Notas de marca

- Tokens centralizados en `colors_and_type.css`. No hardcodear hex salvo los colores
  de etapa (definidos en `data.js`/`styles.css`).
- Sin gradientes. Un solo acento coral por pantalla. Eggplant = tinta; lavanda =
  superficie. Sobre fondo `#1D0446`, el texto destacado va en coral `#FA5478`.
- Tipografía: Poppins (display) · Mulish (body) · JetBrains Mono (datos/montos).
```

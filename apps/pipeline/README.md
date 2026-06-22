# mambo · App de Pipeline (piloto Perú)

App web responsiva **mobile-first** para que los gerentes comerciales actualicen su
pipeline en segundos, con una mano, desde el celular. Reemplaza la fricción de editar
en Pipedrive/CRM de escritorio.

Construida según el handoff técnico (PRD): foundations de marca, especificación
funcional y modelo de datos. Sin backend — persistencia en `localStorage`.

## Estructura

```
apps/pipeline/
├── index.html              # estructura de la app (pantallas 01–04)
├── styles.css              # estilos de la app (importa colors_and_type.css)
├── colors_and_type.css     # foundations de marca: color, tipografía, tokens
├── data.js                 # datos de arranque (131 negocios, ver SEED_DEALS) + catálogos
├── app.js                  # lógica: filtros, edición, perdido, export, import CSV
├── manifest.webmanifest    # PWA: nombre, íconos, display standalone, colores
├── service-worker.js       # PWA: precache del app shell + offline básico
├── icons/                  # íconos PWA (192, 512, 512-maskable, apple-touch 180)
└── vercel.json             # config de deploy estático
```

## Pantallas

1. **Lista de negocios** — cards (org, título, etapa, monto, prob, avatar);
   filtros por dueño, etapa (chips) y búsqueda; toggle ver/ocultar perdidos;
   header con contador de cambios + total "en juego".
2. **Detalle / edición** — tags read-only (vertical, tipo de cliente, industria,
   origen); editable: etapa, monto, probabilidad, comentario; barra de guardado sticky.
3. **Marcar perdido** — toggle en el detalle; motivo obligatorio (bloquea el guardado
   con mensaje de error visible).
4. **Exportar cambios** — bottom sheet con los negocios modificados; copiar resumen
   (texto para WhatsApp); descargar CSV (UTF-8 con BOM); reiniciar cambios.

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

## Datos de arranque (`data.js`)

La app lee los negocios al iniciar desde `data.js` (`SEED_DEALS`), que se carga con
`<script src="data.js">`. **No hay CSV empaquetado ni build**: `data.js` ES la fuente
de datos. Actualmente contiene **131 negocios** generados desde el export de Pipedrive
`Segunda base de datos app pipeline mambo.csv`.

`SEED_VERSION` marca la versión de estos datos. Al cambiarla, la app descarta el
`localStorage` viejo y recarga `SEED_DEALS` (así un refresco de base de datos se
propaga a los usuarios que ya abrieron la app). El service worker también sube de
versión (`mambo-pipeline-vN`) para que no quede `data.js` cacheado.

**Para refrescar los datos** (regenerar `data.js` desde un CSV nuevo de Pipedrive):
mapear las columnas `Negocio - Organización/Título/Valor del negocio/Propietario/
Estado/Fuente lead/Fecha de cierre prevista/Probabilidad/Vertical/Etapa/Tipo de
cliente` y `Organización - Industria` al modelo, asignar `id` correlativo, y subir
`SEED_VERSION` + la versión del cache del SW.

> El botón **importar** (icono arriba a la derecha) sigue disponible para cargar un
> CSV de Pipedrive en runtime (vía **PapaParse**), pero eso solo afecta `localStorage`
> en ese dispositivo — no cambia los datos empaquetados.

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

## Deploy

Estático + cliente. Sugerido: **Vercel** con **Root Directory = `apps/pipeline`**.

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

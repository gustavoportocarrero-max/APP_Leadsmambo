// ============================================================
// mambo · Pipeline — INSPECCIÓN DE PIPEDRIVE (SOLO LECTURA)
//
// Función serverless (Vercel). Extrae configuración de Pipedrive para mapear
// campos antes de construir la sincronización. NO modifica nada: solo hace
// llamadas GET a la API.
//
// Seguridad:
//   - El token se lee de la variable de entorno PIPEDRIVE_API_TOKEN y NUNCA
//     se devuelve al navegador.
//   - El endpoint está protegido por PIPEDRIVE_INSPECT_KEY (hay que pasar
//     ?key=... en la URL).
//   - Los datos de clientes del negocio de ejemplo se REDACTAN (solo se
//     muestran campos no sensibles: monto, probabilidad, etapa, estado, etc.).
//
// Variables de entorno:
//   PIPEDRIVE_API_TOKEN        (requerida)  token de API de Pipedrive
//   PIPEDRIVE_INSPECT_KEY      (requerida)  clave secreta para abrir este endpoint
//   PIPEDRIVE_COMPANY_DOMAIN   (opcional)   p.ej. "mambo" -> mambo.pipedrive.com
//
// Uso: visita  https://TU-APP.vercel.app/api/pipedrive-inspect?key=TU_CLAVE
// Borra este archivo cuando termines de mapear (es solo de inspección).
// ============================================================

const REQUESTED_STAGES = [
  "Target",
  "Contacto establecido",
  "Primera reunión",
  "Presentación de propuesta",
  "Follow-up y cierre",
  "Nurturing",
];
const REQUESTED_LOST = [
  "Escogieron otro proveedor",
  "Desinterés (dejaron de contestar)",
  "Falta de presupuesto",
];

// Campos NO sensibles del deal que sí mostramos con valor (el resto se redacta).
const SAFE_DEAL_KEYS = [
  "id", "value", "currency", "probability", "stage_id", "pipeline_id",
  "status", "lost_reason", "won_time", "lost_time", "expected_close_date",
  "add_time", "update_time", "stage_change_time",
];

const norm = (s) =>
  (s || "").toString().normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  // Solo lectura: rechazar cualquier método que no sea GET.
  if (req.method !== "GET") {
    res.status(405).send("Solo se permite GET (este endpoint es de solo lectura).");
    return;
  }

  const expectedKey = process.env.PIPEDRIVE_INSPECT_KEY || "";
  const givenKey = (req.query && req.query.key) || "";
  if (!expectedKey || givenKey !== expectedKey) {
    res.status(401).send("No autorizado. Agrega ?key=<PIPEDRIVE_INSPECT_KEY> a la URL.");
    return;
  }

  const token = process.env.PIPEDRIVE_API_TOKEN;
  if (!token) {
    res.status(500).send("Falta la variable de entorno PIPEDRIVE_API_TOKEN en Vercel.");
    return;
  }

  const domain = process.env.PIPEDRIVE_COMPANY_DOMAIN;
  const base = domain
    ? `https://${domain}.pipedrive.com/api/v1`
    : "https://api.pipedrive.com/v1";

  const buildUrl = (path, params = {}) => {
    const u = new URL(base + path);
    u.searchParams.set("api_token", token);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  };
  const get = async (path, params) => {
    const r = await fetch(buildUrl(path, params)); // GET por defecto (solo lectura)
    let j = {};
    try { j = await r.json(); } catch (_) {}
    if (!r.ok || j.success === false) {
      const detail = j && (j.error || j.error_info) ? `${j.error || ""} ${j.error_info || ""}` : `HTTP ${r.status}`;
      throw new Error(`${path}: ${detail}`.trim());
    }
    return j.data;
  };

  const L = [];
  const P = (s = "") => L.push(s);
  const HR = () => P("─".repeat(60));

  P("mambo · Inspección de Pipedrive (SOLO LECTURA)");
  P("Host: " + base.replace(token, ""));
  HR();

  /* ---------- 1) Pipelines y etapas ---------- */
  try {
    const [pipelines, stages] = await Promise.all([get("/pipelines"), get("/stages")]);
    const pipeName = (id) => (pipelines.find((p) => p.id === id) || {}).name || `pipeline ${id}`;

    P("1) PIPELINES Y ETAPAS (stage_id internos)");
    P("");
    pipelines.forEach((p) => {
      P(`  Pipeline #${p.id} — ${p.name}`);
      stages
        .filter((s) => s.pipeline_id === p.id)
        .sort((a, b) => a.order_nr - b.order_nr)
        .forEach((s) => {
          P(`     stage_id ${s.id}  ·  "${s.name}"  (orden ${s.order_nr}, prob. por defecto ${s.deal_probability ?? "—"}%)`);
        });
      P("");
    });

    P("  → Mapeo de las etapas que necesitas:");
    REQUESTED_STAGES.forEach((name) => {
      const match = stages.find((s) => norm(s.name) === norm(name));
      if (match) P(`     "${name}"  →  stage_id ${match.id}  (pipeline: ${pipeName(match.pipeline_id)})`);
      else P(`     "${name}"  →  NO ENCONTRADA (revisa el nombre exacto en Pipedrive)`);
    });
  } catch (e) {
    P("1) PIPELINES Y ETAPAS — error: " + e.message);
  }
  HR();

  /* ---------- 2) Razones de pérdida ---------- */
  try {
    P("2) RAZONES DE PÉRDIDA (lost reasons)");
    P("");
    // La API v1 no expone un catálogo de lost reasons; se muestrean de negocios lost.
    let lostDeals = [];
    try { lostDeals = (await get("/deals", { status: "lost", limit: 100 })) || []; } catch (_) {}
    const used = [...new Set(lostDeals.map((d) => d.lost_reason).filter(Boolean))];

    if (used.length) {
      P("  Razones efectivamente usadas (muestreadas de negocios 'lost'):");
      used.forEach((r) => P(`     · "${r}"`));
    } else {
      P("  No se hallaron negocios 'lost' con razón en la muestra.");
    }
    P("");
    P("  Nota: en la API v1 'lost_reason' es TEXTO LIBRE (string). No hay IDs;");
    P("  al marcar perdido se envía el texto tal cual. Usa exactamente:");
    REQUESTED_LOST.forEach((r) => {
      const found = used.some((u) => norm(u) === norm(r));
      P(`     · "${r}"  ${found ? "(ya en uso ✓)" : "(aún no aparece en la muestra)"}`);
    });
  } catch (e) {
    P("2) RAZONES DE PÉRDIDA — error: " + e.message);
  }
  HR();

  /* ---------- 3) Estructura de un deal ---------- */
  try {
    P("3) CAMPOS DE UN NEGOCIO (deal) — nombres exactos para escribir");
    P("");
    const fields = (await get("/dealFields")) || [];
    P("  Campos estándar relevantes:");
    const relevant = ["value", "currency", "probability", "stage_id", "status", "lost_reason", "expected_close_date", "won_time", "lost_time"];
    fields
      .filter((f) => relevant.includes(f.key))
      .forEach((f) => P(`     key="${f.key}"  ·  "${f.name}"  ·  tipo: ${f.field_type}`));
    P("");
    P(`  (Total de campos en dealFields: ${fields.length} — incluye personalizados.)`);

    // Negocio de ejemplo, con datos de cliente REDACTADOS.
    P("");
    P("  Ejemplo de negocio (campos sensibles redactados):");
    let sample = null;
    try { const ds = await get("/deals", { limit: 1 }); sample = ds && ds[0]; } catch (_) {}
    if (sample) {
      SAFE_DEAL_KEYS.forEach((k) => {
        if (k in sample) P(`     ${k}: ${JSON.stringify(sample[k])}`);
      });
      const others = Object.keys(sample).filter((k) => !SAFE_DEAL_KEYS.includes(k));
      P("");
      P("     Otros campos presentes (solo nombres, valores ocultos):");
      P("     " + others.join(", "));
    } else {
      P("     No se pudo leer un negocio de ejemplo.");
    }
  } catch (e) {
    P("3) CAMPOS DE UN NEGOCIO — error: " + e.message);
  }
  HR();

  /* ---------- 4) Cómo marcar won / lost (documentación) ---------- */
  P("4) CÓMO MARCAR GANADO / PERDIDO VÍA API (referencia, NO ejecutado aquí)");
  P("");
  P("  Ganar:   PUT /deals/{id}   body: { \"status\": \"won\" }");
  P("           - No exige campos extra. Opcional: \"won_time\" (YYYY-MM-DD HH:MM:SS).");
  P("           - El monto/moneda deben existir en el deal si los necesitas.");
  P("");
  P("  Perder:  PUT /deals/{id}   body: { \"status\": \"lost\", \"lost_reason\": \"texto\" }");
  P("           - \"lost_reason\" es texto libre. Es obligatorio solo si tu cuenta");
  P("             tiene activada la opción 'exigir razón de pérdida'.");
  P("");
  P("  Otros campos editables comunes: \"value\", \"currency\", \"probability\",");
  P("  \"stage_id\" (mover de etapa). Todo vía PUT /deals/{id}.");
  P("");
  P("  (Este endpoint NO ejecuta PUT: es solo lectura.)");
  HR();
  P("Fin. Borra api/pipedrive-inspect.js cuando termines de mapear.");

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.status(200).send(L.join("\n"));
}

// ============================================================
// mambo · Pipeline — SINCRONIZACIÓN DE UNA VÍA (app → Pipedrive)
//
// Función serverless (Vercel). La app la llama (POST) al guardar un cambio.
// Escribe en Pipedrive vía PUT /deals/{id}. El token vive solo aquí
// (PIPEDRIVE_API_TOKEN) y NUNCA llega al navegador.
//
// Seguridad / reglas:
//   - Solo escribe en el PIPELINE 1. Antes de escribir, valida (GET) que el
//     deal pertenezca al pipeline 1; si no, NO escribe y lo registra.
//   - Escribe SOLO los campos que cambiaron.
//   - Modo de prueba (dry-run por defecto): ver variables de entorno abajo.
//   - Registra (console.log) cada intento para depurar (Vercel → Logs).
//
// Variables de entorno:
//   PIPEDRIVE_API_TOKEN        (requerida)  token de API
//   PIPEDRIVE_COMPANY_DOMAIN   (opcional)   p.ej. "mambo"
//   PIPEDRIVE_TEST_DEAL_IDS    (opcional)   IDs de Pipedrive separados por coma:
//                                           SOLO esos se escriben de verdad; el
//                                           resto se simula. Úsalo para probar.
//   PIPEDRIVE_SYNC_ENABLED     (opcional)   "true" = escribir de verdad para TODOS
//                                           (solo aplica si NO hay TEST_DEAL_IDS).
//   Sin ninguna de las dos últimas → TODO se simula (no escribe nada).
// ============================================================

const ALLOWED_PIPELINE = 1;

// Etapa de la app → stage_id de Pipedrive (pipeline 1). Fuente de verdad del mapeo.
const STAGE_MAP = {
  target: 1,
  contacto: 2,
  primera: 16,
  propuesta: 52,
  cierre: 55,
  nurturing: 11,
};

function parseIds(s) {
  return (s || "")
    .split(",")
    .map((x) => parseInt(x.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body) {
    try { return JSON.parse(req.body); } catch (_) { return {}; }
  }
  const raw = await new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
    req.on("error", () => resolve(""));
  });
  try { return raw ? JSON.parse(raw) : {}; } catch (_) { return {}; }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Usa POST." });
    return;
  }

  const token = process.env.PIPEDRIVE_API_TOKEN;
  if (!token) {
    res.status(500).json({ ok: false, error: "Falta la variable PIPEDRIVE_API_TOKEN." });
    return;
  }

  const domain = process.env.PIPEDRIVE_COMPANY_DOMAIN;
  const base = domain
    ? `https://${domain}.pipedrive.com/api/v1`
    : "https://api.pipedrive.com/v1";
  const testIds = parseIds(process.env.PIPEDRIVE_TEST_DEAL_IDS);
  const enabled = process.env.PIPEDRIVE_SYNC_ENABLED === "true";

  const log = (obj) => { try { console.log("[pipedrive-sync]", JSON.stringify(obj)); } catch (_) {} };
  const apiUrl = (path) => {
    const u = new URL(base + path);
    u.searchParams.set("api_token", token);
    return u.toString();
  };

  const payload = await readBody(req);
  const pipedriveId = parseInt(payload.pipedriveId, 10);
  const changes = payload.changes || {};

  if (!Number.isFinite(pipedriveId)) {
    res.status(400).json({ ok: false, error: "Falta pipedriveId (numérico)." });
    return;
  }

  // 1) Validar existencia y pipeline (GET, solo lectura)
  let deal;
  try {
    const r = await fetch(apiUrl(`/deals/${pipedriveId}`));
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false || !j.data) {
      log({ pipedriveId, step: "get", ok: false, status: r.status });
      res.status(404).json({ ok: false, error: `No se encontró el deal ${pipedriveId} en Pipedrive.` });
      return;
    }
    deal = j.data;
  } catch (e) {
    log({ pipedriveId, step: "get", error: String(e) });
    res.status(502).json({ ok: false, error: "No se pudo consultar Pipedrive." });
    return;
  }

  if (deal.pipeline_id !== ALLOWED_PIPELINE) {
    log({ pipedriveId, step: "pipeline-check", pipeline_id: deal.pipeline_id, blocked: true });
    res.status(409).json({
      ok: false,
      error: `El deal ${pipedriveId} está en el pipeline ${deal.pipeline_id}, no en el ${ALLOWED_PIPELINE}. No se escribió nada.`,
    });
    return;
  }

  // 2) Construir body SOLO con campos cambiados (mapeo app → Pipedrive)
  const body = {};
  if ("stage" in changes) {
    const sid = STAGE_MAP[changes.stage];
    if (!sid) { res.status(400).json({ ok: false, error: `Etapa desconocida: ${changes.stage}` }); return; }
    body.stage_id = sid;
  }
  if ("amount" in changes) body.value = Number(changes.amount) || 0;
  if ("prob" in changes) body.probability = (changes.prob === null || changes.prob === "") ? null : Number(changes.prob);
  if ("status" in changes) {
    if (changes.status === "ganado") body.status = "won";
    else if (changes.status === "perdido") { body.status = "lost"; body.lost_reason = changes.lossReason || ""; }
    else body.status = "open";
  } else if ("lossReason" in changes) {
    body.lost_reason = changes.lossReason || "";
  }

  // Comentario nuevo → se crea como NOTA del negocio (cada uno deja historial).
  const note = (typeof payload.note === "string" && payload.note.trim()) ? payload.note.trim() : null;
  const hasFields = Object.keys(body).length > 0;

  if (!hasFields && !note) {
    res.status(200).json({ ok: true, simulated: true, noChanges: true, message: "Sin campos ni nota para escribir." });
    return;
  }

  const willWrite = testIds.length ? testIds.includes(pipedriveId) : enabled;
  const modeLabel = testIds.length ? "test-ids" : (enabled ? "enabled" : "dry-run");
  log({ pipedriveId, pipeline_id: deal.pipeline_id, body, note: note ? note.slice(0, 80) : null, willWrite, mode: modeLabel });

  // 3) Dry-run: no escribir, solo informar qué se escribiría
  if (!willWrite) {
    res.status(200).json({
      ok: true, simulated: true, dealId: pipedriveId, wouldWrite: body, wouldAddNote: !!note,
      message: "Simulado: NO se escribió en Pipedrive (modo prueba).",
    });
    return;
  }

  // 4) Escribir los campos del deal (PUT), si hay
  let applied = {};
  let confirmed = true;
  if (hasFields) {
    let putJson;
    try {
      const r = await fetch(apiUrl(`/deals/${pipedriveId}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      putJson = await r.json().catch(() => ({}));
      if (!r.ok || putJson.success === false) {
        log({ pipedriveId, step: "put", ok: false, status: r.status, error: putJson.error });
        res.status(502).json({ ok: false, error: `Pipedrive rechazó la escritura: ${putJson.error || "HTTP " + r.status}` });
        return;
      }
    } catch (e) {
      log({ pipedriveId, step: "put", error: String(e) });
      res.status(502).json({ ok: false, error: "Error de red al escribir en Pipedrive." });
      return;
    }
    // Confirmar con la respuesta (el PUT devuelve el deal actualizado).
    const after = putJson.data || {};
    if ("stage_id" in body && after.stage_id !== body.stage_id) confirmed = false;
    if ("status" in body && after.status !== body.status) confirmed = false;
    if ("value" in body && Number(after.value) !== Number(body.value)) confirmed = false; // p.ej. deals con productos no aceptan value
    applied = { stage_id: after.stage_id, value: after.value, probability: after.probability, status: after.status };
  }

  // 5) Crear la nota (si hay comentario nuevo) — POST /notes con deal_id
  let noteCreated = false, noteError = null;
  if (note) {
    try {
      const r = await fetch(apiUrl(`/notes`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deal_id: pipedriveId, content: note }),
      });
      const nj = await r.json().catch(() => ({}));
      if (!r.ok || nj.success === false) { noteError = nj.error || ("HTTP " + r.status); log({ pipedriveId, step: "note", ok: false, error: noteError }); }
      else noteCreated = true;
    } catch (e) {
      noteError = String(e);
      log({ pipedriveId, step: "note", error: noteError });
    }
    // Si SOLO se pidió la nota (sin campos) y falló → error duro.
    if (!hasFields && !noteCreated) {
      res.status(502).json({ ok: false, error: `No se pudo crear la nota: ${noteError}` });
      return;
    }
  }

  log({ pipedriveId, step: "done", applied, confirmed, noteCreated, noteError });
  res.status(confirmed ? 200 : 502).json({
    ok: confirmed,
    simulated: false,
    confirmed,
    dealId: pipedriveId,
    applied,
    noteCreated,
    noteWarning: (note && !noteCreated) ? `Los campos se guardaron, pero la nota falló: ${noteError}` : undefined,
    error: confirmed ? undefined : "Pipedrive no confirmó algún campo (¿el negocio usa productos? entonces el monto está bloqueado). Revisa el negocio.",
  });
}

// ============================================================
// mambo · Pipeline — SINCRONIZACIÓN DE ENTRADA (Pipedrive → Supabase)
//
// Se ejecuta por cron (cada 2h) o manualmente. Server-side: usa el token de
// Pipedrive y la SERVICE ROLE key de Supabase desde variables de entorno.
// SOLO toca el pipeline 1. Nunca expone secretos al navegador.
//
// Qué hace cada corrida:
//  - Trae los negocios ABIERTOS del pipeline 1 desde Pipedrive.
//  - Inserta los nuevos (con su pipedrive_id y su add_time real como created_at).
//  - Actualiza los existentes (Pipedrive manda), EXCEPTO los que en la app están
//    marcados como pendientes (sync_pending=true): esos no se pisan.
//  - Borra de la app los que en Pipedrive quedaron GANADOS/PERDIDOS o salieron del
//    pipeline 1 (también respetando los pendientes).
//  - Registra conteos: nuevos, actualizados, quitados, saltados, errores.
//
// Variables de entorno:
//   PIPEDRIVE_API_TOKEN        (requerida)
//   PIPEDRIVE_COMPANY_DOMAIN   (opcional)
//   SUPABASE_URL               (requerida)
//   SUPABASE_SERVICE_ROLE_KEY  (requerida — NUNCA la anon; NUNCA al navegador)
//   CRON_SECRET                (requerida) — protege el endpoint
//
// Disparo manual:  GET /api/pipedrive-pull?key=<CRON_SECRET>
// ============================================================

const ALLOWED_PIPELINE = 1;

// stage_id de Pipedrive → id de etapa de la app (inverso del mapa de salida)
const STAGE_BY_PD_ID = { 1: "target", 2: "contacto", 16: "primera", 52: "propuesta", 55: "cierre", 11: "nurturing" };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || "";
  const key = (req.query && req.query.key) || "";
  if (!secret || (auth !== `Bearer ${secret}` && key !== secret)) {
    res.status(401).json({ ok: false, error: "No autorizado (falta CRON_SECRET correcto)." });
    return;
  }

  const token = process.env.PIPEDRIVE_API_TOKEN;
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!token || !sbUrl || !sbKey) {
    res.status(500).json({ ok: false, error: "Faltan variables: PIPEDRIVE_API_TOKEN / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY." });
    return;
  }

  const domain = process.env.PIPEDRIVE_COMPANY_DOMAIN;
  const pdBase = domain ? `https://${domain}.pipedrive.com/api/v1` : "https://api.pipedrive.com/v1";
  const started = Date.now();
  const errors = [];

  // ---- Supabase REST (service role: bypassa RLS) ----
  const sbHeaders = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, "Content-Type": "application/json" };
  const sb = async (path, opts = {}) => {
    const r = await fetch(`${sbUrl}/rest/v1/${path}`, { ...opts, headers: { ...sbHeaders, ...(opts.headers || {}) } });
    if (!r.ok) throw new Error(`Supabase ${opts.method || "GET"} ${path} → HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r;
  };

  try {
    // 1) Traer TODOS los negocios del pipeline 1 desde Pipedrive (paginado)
    const pdDeals = [];
    let start = 0;
    for (let guard = 0; guard < 100; guard++) {
      const u = new URL(`${pdBase}/pipelines/${ALLOWED_PIPELINE}/deals`);
      u.searchParams.set("api_token", token);
      u.searchParams.set("status", "all_not_deleted");
      u.searchParams.set("limit", "100");
      u.searchParams.set("start", String(start));
      const r = await fetch(u.toString());
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.success === false) throw new Error(`Pipedrive deals → HTTP ${r.status} ${JSON.stringify(j.error || "")}`);
      (j.data || []).forEach((d) => pdDeals.push(d));
      const pag = j.additional_data && j.additional_data.pagination;
      if (pag && pag.more_items_in_collection) { start = pag.next_start; } else { break; }
    }

    // Solo pipeline 1 (defensa extra) y separar abiertos de cerrados
    const inP1 = pdDeals.filter((d) => Number(d.pipeline_id) === ALLOWED_PIPELINE);
    const openDeals = inP1.filter((d) => d.status === "open");
    const openIds = new Set(openDeals.map((d) => Number(d.id)));

    // 2) Estado actual en Supabase (solo filas con pipedrive_id)
    const existing = await (await sb("deals?select=pipedrive_id,sync_pending&pipedrive_id=not.is.null")).json();
    const existingPids = new Set(existing.map((r) => Number(r.pipedrive_id)));
    const pendingPids = new Set(existing.filter((r) => r.sync_pending).map((r) => Number(r.pipedrive_id)));

    // 3) Mapear deals abiertos → filas de la app (excluyendo los pendientes)
    const toUpsert = [];
    let newCount = 0, updCount = 0, skipCount = 0;
    for (const d of openDeals) {
      const pid = Number(d.id);
      if (pendingPids.has(pid)) { skipCount++; continue; } // respetar cambios locales sin confirmar
      const addTime = d.add_time ? d.add_time.replace(" ", "T") + "Z" : null;
      toUpsert.push({
        pipedrive_id: pid,
        org: (d.org_name || (d.org_id && d.org_id.name) || "").toString(),
        title: (d.title || "").toString(),
        owner: (d.owner_name || (d.user_id && d.user_id.name) || "").toString(),
        stage: STAGE_BY_PD_ID[Number(d.stage_id)] || "target",
        amount: Number(d.value) || 0,
        prob: (d.probability === null || d.probability === undefined) ? null : Number(d.probability),
        status: "activo",
        close_date: d.expected_close_date || null,
        created_at: addTime,
        sync_pending: false,
      });
      if (existingPids.has(pid)) updCount++; else newCount++;
    }

    // 4) Upsert masivo (inserta nuevos + actualiza existentes por pipedrive_id)
    if (toUpsert.length) {
      await sb("deals?on_conflict=pipedrive_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(toUpsert),
      });
    }

    // 5) Borrar los que ya no están abiertos en el pipeline 1 (ganados/perdidos o
    //    movidos a otro pipeline), respetando los pendientes.
    const toDelete = [...existingPids].filter((pid) => !openIds.has(pid) && !pendingPids.has(pid));
    let delCount = 0;
    if (toDelete.length) {
      // borrar en lotes por si son muchos
      for (let i = 0; i < toDelete.length; i += 100) {
        const chunk = toDelete.slice(i, i + 100);
        await sb(`deals?pipedrive_id=in.(${chunk.join(",")})`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
        delCount += chunk.length;
      }
    }

    const summary = {
      ok: true,
      pipeline: ALLOWED_PIPELINE,
      pipedrive_total_en_pipeline: inP1.length,
      abiertos: openDeals.length,
      nuevos: newCount,
      actualizados: updCount,
      quitados_por_cierre: delCount,
      saltados_por_pendientes: skipCount,
      ms: Date.now() - started,
      errores: errors,
    };
    console.log("[pipedrive-pull]", JSON.stringify(summary));
    res.status(200).json(summary);
  } catch (e) {
    const fail = { ok: false, error: String(e && e.message ? e.message : e), ms: Date.now() - started };
    console.error("[pipedrive-pull] ERROR", JSON.stringify(fail));
    res.status(502).json(fail);
  }
}

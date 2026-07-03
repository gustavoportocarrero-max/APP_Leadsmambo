// ============================================================
// mambo · Pipeline — SINCRONIZACIÓN DE ENTRADA (Pipedrive → Supabase)
//
// Cron o manual. Server-side: token de Pipedrive + SERVICE ROLE de Supabase
// desde variables de entorno. SOLO pipeline 1. Nunca expone secretos.
//
// Trae abiertos del pipeline 1: inserta nuevos (con add_time real como created_at),
// actualiza existentes (Pipedrive manda) SALVO los sync_pending=true, y borra los
// que quedaron ganados/perdidos o fuera del pipeline 1 (respetando pendientes).
//
// Campos descriptivos (personalizados) se AUTO-DESCUBREN por nombre desde
// dealFields/organizationFields (sus claves internas son hashes que varían por
// cuenta): Vertical, Tipo de cliente, Tipo de Venta, Fuente lead (del negocio) e
// Industria (de la organización). Se traduce id-de-opción → texto legible.
//
// Variables de entorno:
//   PIPEDRIVE_API_TOKEN, PIPEDRIVE_COMPANY_DOMAIN (opcional),
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET
//
// Disparo manual:   GET /api/pipedrive-pull?key=<CRON_SECRET>
// Ver mapeo campos: GET /api/pipedrive-pull?key=<CRON_SECRET>&fields=1  (no sincroniza)
// ============================================================

const ALLOWED_PIPELINE = 1;
const STAGE_BY_PD_ID = { 1: "target", 2: "contacto", 16: "primera", 52: "propuesta", 55: "cierre", 11: "nurturing" };

// Nombre visible del campo en Pipedrive → columna de la app.
const DEAL_FIELD_NAMES = {
  vertical: "vertical",
  client_type: "tipo de cliente",
  sale_type: "tipo de venta",
  source: "fuente lead",
};
const ORG_FIELD_NAME_INDUSTRY = "industria";

const norm = (s) => (s || "").toString().toLowerCase().trim();

function optionsOf(field) {
  if (!field || !Array.isArray(field.options)) return null;
  const map = {};
  field.options.forEach((o) => { map[String(o.id)] = o.label; });
  return map;
}
// value puede ser id (enum) o "id1,id2" (set) → texto legible
function optLabel(val, opts) {
  if (val === null || val === undefined || val === "") return "";
  if (!opts) return String(val);
  const labels = String(val).split(",").map((s) => opts[s.trim()]).filter((x) => x != null);
  return labels.join(", ");
}

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
  if (!token) { res.status(500).json({ ok: false, error: "Falta PIPEDRIVE_API_TOKEN." }); return; }

  const domain = process.env.PIPEDRIVE_COMPANY_DOMAIN;
  const pdBase = domain ? `https://${domain}.pipedrive.com/api/v1` : "https://api.pipedrive.com/v1";
  const debugFields = req.query && req.query.fields === "1";

  const pd = async (path, params = {}) => {
    const u = new URL(pdBase + path);
    u.searchParams.set("api_token", token);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const r = await fetch(u.toString());
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) throw new Error(`Pipedrive ${path} → HTTP ${r.status} ${JSON.stringify(j.error || "")}`);
    return j;
  };

  // ---- Descubrir campos personalizados por nombre ----
  async function discoverFields() {
    const out = { vertical: null, client_type: null, sale_type: null, source: null, industry: null, notFound: [] };
    const df = (await pd("/dealFields", { limit: "500" })).data || [];
    for (const f of df) {
      const n = norm(f.name);
      for (const [col, target] of Object.entries(DEAL_FIELD_NAMES)) {
        if (n === target) out[col] = { key: f.key, name: f.name, type: f.field_type, opts: optionsOf(f) };
      }
    }
    try {
      const of = (await pd("/organizationFields", { limit: "500" })).data || [];
      const found = of.find((f) => norm(f.name) === ORG_FIELD_NAME_INDUSTRY);
      if (found) out.industry = { key: found.key, name: found.name, type: found.field_type, opts: optionsOf(found) };
    } catch (e) { /* org fields opcional */ }
    ["vertical", "client_type", "sale_type", "source", "industry"].forEach((c) => { if (!out[c]) out.notFound.push(c); });
    return out;
  }

  // ---- Modo debug: mostrar qué campos/opciones encontró (no sincroniza) ----
  if (debugFields) {
    try {
      const f = await discoverFields();
      const describe = (x) => x ? { name: x.name, key: x.key, type: x.type, opciones: x.opts || "(sin opciones / texto libre)" } : "NO ENCONTRADO";
      res.status(200).json({
        ok: true,
        encontrados: {
          Vertical: describe(f.vertical),
          "Tipo de cliente": describe(f.client_type),
          "Tipo de Venta": describe(f.sale_type),
          "Fuente lead": describe(f.source),
          "Industria (organización)": describe(f.industry),
        },
        faltantes: f.notFound,
      });
    } catch (e) {
      res.status(502).json({ ok: false, error: String(e && e.message ? e.message : e) });
    }
    return;
  }

  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) { res.status(500).json({ ok: false, error: "Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY." }); return; }

  const sbHeaders = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, "Content-Type": "application/json" };
  const sb = async (path, opts = {}) => {
    const r = await fetch(`${sbUrl}/rest/v1/${path}`, { ...opts, headers: { ...sbHeaders, ...(opts.headers || {}) } });
    if (!r.ok) throw new Error(`Supabase ${opts.method || "GET"} ${path} → HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r;
  };

  const started = Date.now();
  try {
    const fields = await discoverFields();

    // Industria vive en la organización → mapear orgId → industria (una vez por corrida)
    const orgIndustria = {};
    if (fields.industry) {
      let s = 0;
      for (let g = 0; g < 100; g++) {
        const j = await pd("/organizations", { limit: "100", start: String(s) });
        (j.data || []).forEach((o) => { orgIndustria[String(o.id)] = optLabel(o[fields.industry.key], fields.industry.opts); });
        const pag = j.additional_data && j.additional_data.pagination;
        if (pag && pag.more_items_in_collection) s = pag.next_start; else break;
      }
    }

    // 1) Traer negocios del pipeline 1 (paginado)
    const pdDeals = [];
    let start = 0;
    for (let g = 0; g < 100; g++) {
      const j = await pd(`/pipelines/${ALLOWED_PIPELINE}/deals`, { status: "all_not_deleted", limit: "100", start: String(start) });
      (j.data || []).forEach((d) => pdDeals.push(d));
      const pag = j.additional_data && j.additional_data.pagination;
      if (pag && pag.more_items_in_collection) start = pag.next_start; else break;
    }

    const inP1 = pdDeals.filter((d) => Number(d.pipeline_id) === ALLOWED_PIPELINE);
    const openDeals = inP1.filter((d) => d.status === "open");
    const openIds = new Set(openDeals.map((d) => Number(d.id)));

    // 2) Estado actual en Supabase
    const existing = await (await sb("deals?select=pipedrive_id,sync_pending&pipedrive_id=not.is.null")).json();
    const existingPids = new Set(existing.map((r) => Number(r.pipedrive_id)));
    const pendingPids = new Set(existing.filter((r) => r.sync_pending).map((r) => Number(r.pipedrive_id)));

    // Columnas descriptivas a escribir (solo las que se descubrieron, para no pisar
    // con vacío lo que ya existe). Mismo set para todas las filas (upsert uniforme).
    const orgIdOf = (d) => String((d.org_id && d.org_id.value) || (d.org_id && d.org_id.id) || d.org_id || "");

    const toUpsert = [];
    let newCount = 0, updCount = 0, skipCount = 0;
    for (const d of openDeals) {
      const pid = Number(d.id);
      if (pendingPids.has(pid)) { skipCount++; continue; }
      const addTime = d.add_time ? d.add_time.replace(" ", "T") + "Z" : null;
      const row = {
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
      };
      if (fields.vertical) row.vertical = optLabel(d[fields.vertical.key], fields.vertical.opts);
      if (fields.client_type) row.client_type = optLabel(d[fields.client_type.key], fields.client_type.opts);
      if (fields.sale_type) row.sale_type = optLabel(d[fields.sale_type.key], fields.sale_type.opts);
      if (fields.source) row.source = optLabel(d[fields.source.key], fields.source.opts);
      if (fields.industry) row.industry = orgIndustria[orgIdOf(d)] || "";
      toUpsert.push(row);
      if (existingPids.has(pid)) updCount++; else newCount++;
    }

    // 3) Upsert masivo por pipedrive_id
    if (toUpsert.length) {
      await sb("deals?on_conflict=pipedrive_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(toUpsert),
      });
    }

    // 4) Borrar cerrados / fuera del pipeline 1 (respetando pendientes)
    const toDelete = [...existingPids].filter((pid) => !openIds.has(pid) && !pendingPids.has(pid));
    let delCount = 0;
    for (let i = 0; i < toDelete.length; i += 100) {
      const chunk = toDelete.slice(i, i + 100);
      await sb(`deals?pipedrive_id=in.(${chunk.join(",")})`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
      delCount += chunk.length;
    }

    const summary = {
      ok: true,
      pipeline: ALLOWED_PIPELINE,
      abiertos: openDeals.length,
      nuevos: newCount,
      actualizados: updCount,
      quitados_por_cierre: delCount,
      saltados_por_pendientes: skipCount,
      campos_descriptivos: {
        mapeados: ["vertical", "client_type", "sale_type", "source", "industry"].filter((c) => fields[c]),
        no_encontrados: fields.notFound,
      },
      ms: Date.now() - started,
    };
    console.log("[pipedrive-pull]", JSON.stringify(summary));
    res.status(200).json(summary);
  } catch (e) {
    const fail = { ok: false, error: String(e && e.message ? e.message : e), ms: Date.now() - started };
    console.error("[pipedrive-pull] ERROR", JSON.stringify(fail));
    res.status(502).json(fail);
  }
}

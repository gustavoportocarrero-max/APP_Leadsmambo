// ============================================================
// mambo · Pipeline — PENDIENTES POR PARTNER (consulta viva a Pipedrive)
//
// Módulo auxiliar ("_" → no es ruta). Lo usa weekly-email para armar, al momento
// de enviar cada correo, el resumen accionable de cada partner. Consulta Pipedrive
// EN VIVO (pipeline 1) una sola vez por ejecución y calcula 3 bloques por partner:
//
//   A) Negocios ANTIGUOS: creados hace >30 días (add_time), en una de las 4 etapas
//      (contacto, primera, propuesta, cierre).
//   B) Negocios en FOLLOW-UP Y CIERRE (etapa "cierre").
//   C) Negocios con CAMPOS OBLIGATORIOS incompletos, según su etapa.
//
// Campos obligatorios por etapa:
//   contacto:  Industria, Tipo de cliente, País, Persona de contacto, Fuente lead
//   primera:   Industria, Tipo de cliente, Fuente lead, País, Probabilidad
//   propuesta: + Vertical, Valor (monto), Tipo de Venta, Fecha de cierre  (9)
//   cierre:    los mismos 9 de propuesta
//   (target y nurturing NO se evalúan)
//
// Campos de lista se descubren por nombre (claves internas = hashes por cuenta),
// como en pipedrive-pull/meta. Industria vive en la ORGANIZACIÓN.
//
// Env: PIPEDRIVE_API_TOKEN (requerida), PIPEDRIVE_COMPANY_DOMAIN (opcional).
// ============================================================

const ALLOWED_PIPELINE = 1;
const STAGE_BY_PD_ID = { 1: "target", 2: "contacto", 16: "primera", 52: "propuesta", 55: "cierre", 11: "nurturing" };
const STAGE_LABEL = {
  contacto: "Contacto establecido", primera: "Primera reunión",
  propuesta: "Presentación de propuesta", cierre: "Follow-up y cierre",
};
const FOUR_STAGES = new Set(["contacto", "primera", "propuesta", "cierre"]);

// Campos obligatorios por etapa (claves lógicas).
const REQUIRED = {
  contacto: ["industria", "client_type", "country", "person", "source"],
  primera: ["industria", "client_type", "source", "country", "prob"],
  propuesta: ["industria", "client_type", "source", "country", "prob", "vertical", "value", "sale_type", "close"],
  cierre: ["industria", "client_type", "source", "country", "prob", "vertical", "value", "sale_type", "close"],
};
const FIELD_LABEL = {
  industria: "Industria", client_type: "Tipo de cliente", country: "País",
  person: "Persona de contacto", source: "Fuente lead", prob: "Probabilidad",
  vertical: "Vertical", value: "Valor (monto)", sale_type: "Tipo de Venta", close: "Fecha de cierre prevista",
};

// Nombre visible del campo (minúsculas) → clave lógica del negocio.
const DEAL_FIELD_NAMES = {
  vertical: ["vertical"],
  client_type: ["tipo de cliente"],
  sale_type: ["tipo de venta"],
  source: ["fuente lead"],
  country: ["país", "pais"],
};
const ORG_FIELD_NAME_INDUSTRY = ["industria"];

const norm = (s) => (s || "").toString().toLowerCase().trim();
const nonEmpty = (v) => v !== null && v !== undefined && String(v).trim() !== "";
const orgIdOf = (d) => String((d.org_id && (d.org_id.value != null ? d.org_id.value : d.org_id.id)) || d.org_id || "");
function hasPerson(d) {
  const p = d.person_id;
  if (p && typeof p === "object") return p.value != null || p.id != null;
  return p != null && p !== "";
}
const ownerNameOf = (d) => (d.owner_name || (d.user_id && d.user_id.name) || "").toString();

export async function fetchPendingByPartner(partnersList) {
  const token = process.env.PIPEDRIVE_API_TOKEN;
  if (!token) return { ok: false, error: "Falta PIPEDRIVE_API_TOKEN.", byPartner: {} };

  const domain = process.env.PIPEDRIVE_COMPANY_DOMAIN;
  const pdBase = domain ? `https://${domain}.pipedrive.com/api/v1` : "https://api.pipedrive.com/v1";
  const pd = async (path, params = {}) => {
    const u = new URL(pdBase + path);
    u.searchParams.set("api_token", token);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const r = await fetch(u.toString());
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) throw new Error(`Pipedrive ${path} → HTTP ${r.status}`);
    return j;
  };

  try {
    // 1) Descubrir claves de campos de lista por nombre.
    const keys = { vertical: null, client_type: null, sale_type: null, source: null, country: null };
    const df = (await pd("/dealFields", { limit: "500" })).data || [];
    for (const f of df) {
      const n = norm(f.name);
      for (const [col, names] of Object.entries(DEAL_FIELD_NAMES)) {
        if (names.includes(n)) keys[col] = f.key;
      }
    }
    let industryKey = null;
    try {
      const of = (await pd("/organizationFields", { limit: "500" })).data || [];
      const found = of.find((f) => ORG_FIELD_NAME_INDUSTRY.includes(norm(f.name)));
      if (found) industryKey = found.key;
    } catch (_) { /* opcional */ }

    // 2) Industria por organización (una pasada).
    const orgIndustria = {};
    if (industryKey) {
      let s = 0;
      for (let g = 0; g < 100; g++) {
        const j = await pd("/organizations", { limit: "500", start: String(s) });
        (j.data || []).forEach((o) => { orgIndustria[String(o.id)] = nonEmpty(o[industryKey]) ? o[industryKey] : ""; });
        const pag = j.additional_data && j.additional_data.pagination;
        if (pag && pag.more_items_in_collection) s = pag.next_start; else break;
      }
    }

    // 3) Todos los negocios ABIERTOS del pipeline 1 (una pasada).
    const deals = [];
    let s = 0;
    for (let g = 0; g < 100; g++) {
      const j = await pd(`/pipelines/${ALLOWED_PIPELINE}/deals`, { status: "open", limit: "500", start: String(s) });
      (j.data || []).forEach((d) => { if (Number(d.pipeline_id) === ALLOWED_PIPELINE) deals.push(d); });
      const pag = j.additional_data && j.additional_data.pagination;
      if (pag && pag.more_items_in_collection) s = pag.next_start; else break;
    }

    // 4) ¿Tiene el campo `field`? (para bloque C)
    const has = (field, d) => {
      switch (field) {
        case "industria": return industryKey ? nonEmpty(orgIndustria[orgIdOf(d)]) : true; // sin campo → no se evalúa
        case "client_type": return keys.client_type ? nonEmpty(d[keys.client_type]) : true;
        case "country": return keys.country ? nonEmpty(d[keys.country]) : true;
        case "source": return keys.source ? nonEmpty(d[keys.source]) : true;
        case "vertical": return keys.vertical ? nonEmpty(d[keys.vertical]) : true;
        case "sale_type": return keys.sale_type ? nonEmpty(d[keys.sale_type]) : true;
        case "person": return hasPerson(d);
        case "prob": return d.probability !== null && d.probability !== undefined;
        case "value": return Number(d.value) > 0;
        case "close": return nonEmpty(d.expected_close_date);
        default: return true;
      }
    };

    // 5) Agrupar por partner.
    const wanted = new Set(partnersList.map(norm));
    const byPartner = {};
    partnersList.forEach((p) => { byPartner[p] = { antiguos: [], cierre: [], incompletos: [] }; });
    const nameToDisplay = {};
    partnersList.forEach((p) => { nameToDisplay[norm(p)] = p; });

    const now = Date.now();
    const THIRTY_D = 30 * 24 * 60 * 60 * 1000;

    for (const d of deals) {
      const on = norm(ownerNameOf(d));
      if (!wanted.has(on)) continue;
      const partner = nameToDisplay[on];
      const stage = STAGE_BY_PD_ID[Number(d.stage_id)] || "target";
      if (!FOUR_STAGES.has(stage)) continue; // target/nurturing fuera

      const title = (d.title || "(sin título)").toString();
      const org = (d.org_name || (d.org_id && d.org_id.name) || "").toString();
      const stageLabel = STAGE_LABEL[stage];

      // Bloque A: antigüedad > 30 días por add_time
      const addMs = d.add_time ? Date.parse(d.add_time.replace(" ", "T") + "Z") : NaN;
      if (!Number.isNaN(addMs) && (now - addMs) > THIRTY_D) {
        const ageDays = Math.floor((now - addMs) / (24 * 60 * 60 * 1000));
        byPartner[partner].antiguos.push({ title, org, stageLabel, ageDays });
      }

      // Bloque B: etapa cierre
      if (stage === "cierre") byPartner[partner].cierre.push({ title, org });

      // Bloque C: campos obligatorios faltantes
      const missing = (REQUIRED[stage] || []).filter((f) => !has(f, d)).map((f) => FIELD_LABEL[f]);
      if (missing.length) byPartner[partner].incompletos.push({ title, org, stageLabel, missing });
    }

    return { ok: true, byPartner, camposDescubiertos: { ...keys, industria: !!industryKey }, negocios: deals.length };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e), byPartner: {} };
  }
}

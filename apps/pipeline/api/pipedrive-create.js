// ============================================================
// mambo · Pipeline — CREAR NEGOCIO (app → Pipedrive)
//
// POST server-side. La app lo llama al enviar el formulario "Nuevo negocio".
// Crea, EN ORDEN y con rollback si algo falla a mitad:
//   1) ORGANIZACIÓN (si es nueva)  → POST /organizations  (con Industria si aplica)
//   2) PERSONA de contacto (opcional) → POST /persons (tel/correo si los hay)
//   3) NEGOCIO en el PIPELINE 1    → POST /deals  (owner=user_id, campos de lista, País)
// Devuelve el negocio ya formado para que la app lo inserte en Supabase.
//
// El token de Pipedrive vive solo aquí. Requiere sesión válida de Supabase
// (Authorization: Bearer <access_token>) — ver api/_auth.js.
//
// Escritura segura: por defecto SIMULA (dry-run). Escribe de verdad solo si
// PIPEDRIVE_CREATE_ENABLED === "true". Así puedes probar sin activar escritura
// global de edición (esa es PIPEDRIVE_SYNC_ENABLED, independiente).
//
// Variables de entorno:
//   PIPEDRIVE_API_TOKEN, PIPEDRIVE_COMPANY_DOMAIN (opcional),
//   PIPEDRIVE_CREATE_ENABLED ("true" = crear de verdad),
//   PIPEDRIVE_PARTNER_USERS (opcional, "Nombre:userId,..."),
//   + las de _auth.js.
// ============================================================

import { verifyUser } from "./_auth.js";

const ALLOWED_PIPELINE = 1;

// Etapa de la app → stage_id de Pipedrive (pipeline 1). Igual que en pipedrive-sync.
const STAGE_MAP = { target: 1, contacto: 2, primera: 16, propuesta: 52, cierre: 55, nurturing: 11 };

const DEAL_FIELD_NAMES = {
  vertical: ["vertical"],
  client_type: ["tipo de cliente"],
  sale_type: ["tipo de venta"],
  source: ["fuente lead"],
  country: ["país", "pais"],
};
const ORG_FIELD_NAME_INDUSTRY = ["industria"];

const norm = (s) => (s || "").toString().toLowerCase().trim();
const COMBINING = new RegExp("[\\u0300-\\u036f]", "g");
const stripAccents = (s) => norm(s).normalize("NFD").replace(COMBINING, "");

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

// Mapa norm(label) → optionId, tolerante a acentos (Perú/Peru).
function labelToId(field) {
  const m = {};
  if (field && Array.isArray(field.options)) {
    field.options.forEach((o) => {
      m[norm(o.label)] = String(o.id);
      m[stripAccents(o.label)] = String(o.id);
    });
  }
  return m;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.status(405).json({ ok: false, error: "Usa POST." }); return; }

  const auth = await verifyUser(req);
  if (!auth.ok) { res.status(auth.status).json({ ok: false, error: auth.error }); return; }

  const token = process.env.PIPEDRIVE_API_TOKEN;
  if (!token) { res.status(500).json({ ok: false, error: "Falta PIPEDRIVE_API_TOKEN." }); return; }

  const domain = process.env.PIPEDRIVE_COMPANY_DOMAIN;
  const pdBase = domain ? `https://${domain}.pipedrive.com/api/v1` : "https://api.pipedrive.com/v1";
  const willWrite = process.env.PIPEDRIVE_CREATE_ENABLED === "true";
  const log = (o) => { try { console.log("[pipedrive-create]", JSON.stringify(o)); } catch (_) {} };

  const pdGet = async (path, params = {}) => {
    const u = new URL(pdBase + path);
    u.searchParams.set("api_token", token);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const r = await fetch(u.toString());
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) throw new Error(`Pipedrive GET ${path} → HTTP ${r.status} ${JSON.stringify(j.error || "")}`);
    return j;
  };
  const pdPost = async (path, bodyObj) => {
    const u = new URL(pdBase + path);
    u.searchParams.set("api_token", token);
    const r = await fetch(u.toString(), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bodyObj),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false || !j.data) throw new Error(`Pipedrive POST ${path} → HTTP ${r.status} ${JSON.stringify(j.error || "")}`);
    return j.data;
  };
  const pdDelete = async (path) => {
    try {
      const u = new URL(pdBase + path);
      u.searchParams.set("api_token", token);
      await fetch(u.toString(), { method: "DELETE" });
    } catch (_) { /* rollback best-effort */ }
  };

  // ---- Entrada ----
  const payload = await readBody(req);
  const title = (payload.title || "").toString().trim();
  const ownerName = (payload.owner || "").toString().trim();
  const stage = (payload.stage || "target").toString();
  const org = payload.org || {};
  const contact = payload.contact || null;
  const inFields = payload.fields || {};

  if (!title) { res.status(400).json({ ok: false, error: "El título es obligatorio." }); return; }
  const stageId = STAGE_MAP[stage];
  if (!stageId) { res.status(400).json({ ok: false, error: `Etapa desconocida: ${stage}` }); return; }
  if (!ownerName) { res.status(400).json({ ok: false, error: "Falta el propietario del negocio." }); return; }

  const orgId = (org.id != null && /^\d+$/.test(String(org.id))) ? Number(org.id) : null;
  const newOrgName = (org.name || "").toString().trim();
  if (!orgId && !newOrgName) { res.status(400).json({ ok: false, error: "Falta la organización (elige una o escribe una nueva)." }); return; }

  const country = (inFields.country || "").toString().trim();
  if (country && !["perú", "peru", "ecuador"].includes(stripAccents(country))) {
    res.status(400).json({ ok: false, error: "País inválido: solo Perú o Ecuador." });
    return;
  }

  try {
    // ---- Descubrir campos (para traducir texto → id de opción) ----
    const dealFieldDefs = {};
    const df = (await pdGet("/dealFields", { limit: "500" })).data || [];
    for (const f of df) {
      const n = norm(f.name);
      for (const [col, names] of Object.entries(DEAL_FIELD_NAMES)) {
        if (names.includes(n)) dealFieldDefs[col] = f;
      }
    }
    let industryDef = null;
    try {
      const of = (await pdGet("/organizationFields", { limit: "500" })).data || [];
      industryDef = of.find((f) => ORG_FIELD_NAME_INDUSTRY.includes(norm(f.name))) || null;
    } catch (_) { /* opcional */ }

    const warnings = [];

    // ---- Resolver owner: nombre de partner → user_id de Pipedrive ----
    let ownerId = null;
    // 1) env override
    if (process.env.PIPEDRIVE_PARTNER_USERS) {
      process.env.PIPEDRIVE_PARTNER_USERS.split(",").forEach((pair) => {
        const i = pair.lastIndexOf(":");
        if (i > 0 && norm(pair.slice(0, i)) === norm(ownerName)) {
          const id = pair.slice(i + 1).trim();
          if (/^\d+$/.test(id)) ownerId = Number(id);
        }
      });
    }
    // 2) usuarios de Pipedrive por nombre exacto
    if (ownerId == null) {
      try {
        const uj = await pdGet("/users");
        const u = (uj.data || []).find((x) => x && norm(x.name) === norm(ownerName));
        if (u) ownerId = u.id;
      } catch (_) { /* seguimos al fallback */ }
    }
    // 3) fallback: un negocio existente del pipeline 1 cuyo owner_name coincide
    if (ownerId == null) {
      try {
        const j = await pdGet(`/pipelines/${ALLOWED_PIPELINE}/deals`, { status: "all_not_deleted", limit: "500" });
        const d = (j.data || []).find((x) => norm(x.owner_name || (x.user_id && x.user_id.name)) === norm(ownerName));
        if (d) {
          const u = d.user_id;
          ownerId = (u && typeof u === "object") ? (u.value != null ? u.value : u.id) : u;
          ownerId = ownerId != null ? Number(ownerId) : null;
        }
      } catch (_) { /* nada */ }
    }
    if (ownerId == null) {
      res.status(400).json({
        ok: false,
        error: `No pude resolver el usuario de Pipedrive para "${ownerName}". Defínelo con PIPEDRIVE_PARTNER_USERS ("${ownerName}:<userId>") o revisa que el nombre coincida con Pipedrive.`,
      });
      return;
    }

    // ---- Traducciones texto → id de opción (negocio) ----
    const dealCustom = {};
    for (const col of ["vertical", "client_type", "sale_type", "source", "country"]) {
      const raw = (inFields[col] || "").toString().trim();
      if (!raw) continue;
      const def = dealFieldDefs[col];
      if (!def) { warnings.push(`El campo "${col}" no existe en Pipedrive por nombre; no se escribió.`); continue; }
      const id = labelToId(def)[norm(raw)] || labelToId(def)[stripAccents(raw)];
      if (id == null) { warnings.push(`La opción "${raw}" no existe para "${col}"; no se escribió.`); continue; }
      dealCustom[def.key] = id;
    }
    // Industria (campo de la organización) → id de opción
    const industryText = (inFields.industry || "").toString().trim();
    let industryOptId = null;
    if (industryText) {
      if (industryDef) {
        industryOptId = labelToId(industryDef)[norm(industryText)] || labelToId(industryDef)[stripAccents(industryText)] || null;
        if (industryOptId == null) warnings.push(`La opción de Industria "${industryText}" no existe; no se escribió.`);
      } else {
        warnings.push('El campo "Industria" no existe en la organización por nombre; no se escribió.');
      }
    }

    // Datos comunes del negocio a devolver a la app (modelo camelCase).
    const amount = Number(payload.amount) || 0;
    const prob = (payload.prob === null || payload.prob === "" || payload.prob === undefined) ? null : Number(payload.prob);
    const closeDate = (payload.closeDate || "").toString().trim() || null;

    // ---- DRY-RUN: no escribe nada, solo informa qué crearía ----
    if (!willWrite) {
      log({ simulated: true, title, ownerName, ownerId, orgId, newOrgName, contact: !!contact });
      res.status(200).json({
        ok: true, simulated: true,
        message: "Simulado: NO se creó nada en Pipedrive (activa PIPEDRIVE_CREATE_ENABLED=true para crear de verdad).",
        wouldCreate: {
          org: orgId ? { id: orgId } : { name: newOrgName, industry: industryText || null },
          person: contact && contact.name ? { name: contact.name, phone: contact.phone || null, email: contact.email || null } : null,
          deal: { title, pipeline_id: ALLOWED_PIPELINE, stage_id: stageId, user_id: ownerId, value: amount, probability: prob, expected_close_date: closeDate, custom: dealCustom },
        },
        warnings,
      });
      return;
    }

    // ---- Escritura real, con rollback ----
    const created = { orgId: null, personId: null };
    try {
      // 1) Organización (nueva) — Industria solo en orgs nuevas.
      let finalOrgId = orgId;
      let finalOrgName = "";
      if (!finalOrgId) {
        const orgBody = { name: newOrgName };
        if (industryOptId != null && industryDef) orgBody[industryDef.key] = industryOptId;
        const o = await pdPost("/organizations", orgBody);
        finalOrgId = o.id;
        finalOrgName = o.name || newOrgName;
        created.orgId = o.id;
      } else {
        // Org existente: no tocamos su Industria (decisión de diseño).
        if (industryText) warnings.push("Industria no se escribió: la organización ya existe y no se modifica.");
        try { const og = await pdGet(`/organizations/${finalOrgId}`); finalOrgName = (og.data && og.data.name) || ""; } catch (_) {}
      }

      // 2) Persona de contacto (opcional).
      let finalPersonId = null;
      if (contact && (contact.name || "").toString().trim()) {
        const personBody = { name: contact.name.toString().trim(), org_id: finalOrgId };
        if ((contact.email || "").toString().trim()) personBody.email = [{ value: contact.email.toString().trim(), primary: true, label: "work" }];
        if ((contact.phone || "").toString().trim()) personBody.phone = [{ value: contact.phone.toString().trim(), primary: true, label: "work" }];
        const p = await pdPost("/persons", personBody);
        finalPersonId = p.id;
        created.personId = p.id;
      }

      // 3) Negocio en el pipeline 1.
      const dealBody = {
        title,
        pipeline_id: ALLOWED_PIPELINE,
        stage_id: stageId,
        user_id: ownerId,
        org_id: finalOrgId,
        value: amount,
      };
      if (finalPersonId) dealBody.person_id = finalPersonId;
      if (prob !== null) dealBody.probability = prob;
      if (closeDate) dealBody.expected_close_date = closeDate;
      Object.assign(dealBody, dealCustom);

      const deal = await pdPost("/deals", dealBody);

      // Negocio ya formado para insertar en Supabase (modelo de la app).
      const outDeal = {
        pipedriveId: deal.id,
        org: (deal.org_name || finalOrgName || newOrgName || "").toString(),
        title,
        owner: ownerName,
        stage,
        amount,
        prob,
        vertical: (inFields.vertical || "").toString().trim(),
        clientType: (inFields.client_type || "").toString().trim(),
        saleType: (inFields.sale_type || "").toString().trim(),
        source: (inFields.source || "").toString().trim(),
        industry: !orgId ? industryText : "", // solo se guardó Industria si la org es nueva
        closeDate: closeDate || "",
      };

      log({ simulated: false, dealId: deal.id, orgId: finalOrgId, personId: finalPersonId, ownerId, warnings });
      res.status(200).json({ ok: true, simulated: false, deal: outDeal, orgId: finalOrgId, personId: finalPersonId, warnings });
    } catch (e) {
      // Rollback: borra lo que sí se creó para no dejar entidades a medias.
      if (created.personId) await pdDelete(`/persons/${created.personId}`);
      if (created.orgId) await pdDelete(`/organizations/${created.orgId}`);
      log({ step: "create", error: String(e && e.message ? e.message : e), rolledBack: created });
      res.status(502).json({
        ok: false,
        error: `No se pudo crear el negocio: ${e && e.message ? e.message : e}. Se revirtió lo creado (org/persona) para no dejar nada a medias.`,
      });
    }
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
}

// ============================================================
// mambo · Pipeline — CATÁLOGOS PARA CREAR NEGOCIOS (Pipedrive → app)
//
// GET server-side. La app lo llama al abrir el formulario "Nuevo negocio".
// Devuelve, en una sola respuesta:
//   - opciones de los campos de lista (Vertical, Tipo de cliente, Tipo de Venta,
//     Fuente lead, País (del negocio) e Industria (de la organización)),
//     descubiertos por NOMBRE (sus claves internas son hashes por cuenta),
//   - la lista de ORGANIZACIONES existentes (id + nombre, alfabético),
//   - el mapeo PARTNER → user_id de Pipedrive (para asignar propietario).
//
// El token de Pipedrive vive solo aquí. Requiere sesión válida de Supabase
// (Authorization: Bearer <access_token>) — ver api/_auth.js.
//
// Variables de entorno:
//   PIPEDRIVE_API_TOKEN, PIPEDRIVE_COMPANY_DOMAIN (opcional),
//   PIPEDRIVE_PARTNER_USERS (opcional, "Nombre:userId,Nombre2:userId2"),
//   PIPEDRIVE_ALLOWED_OWNERS (opcional, lista de partners; default abajo),
//   + las de _auth.js (SUPABASE_URL, SUPABASE_ANON_KEY, ALLOWED_EMAIL_DOMAIN).
//
// Debug (requiere sesión): GET /api/pipedrive-meta?fields=1  → solo mapeo de campos.
// ============================================================

import { verifyUser } from "./_auth.js";

const ALLOWED_PIPELINE = 1;

// Partners del piloto (para resolver su user_id de Pipedrive). Igual a la lista
// blanca del pull; se puede sobreescribir con PIPEDRIVE_ALLOWED_OWNERS.
const DEFAULT_PARTNERS = [
  "Nicolás Aramburú",
  "Renzo Duarte",
  "Cristina Mc",
  "Guillermo Solano",
  "Mauricio",
];

// Nombre visible del campo en Pipedrive (en minúsculas) → clave lógica.
// País acepta "país" o "pais". Industria vive en la organización.
const DEAL_FIELD_NAMES = {
  vertical: ["vertical"],
  client_type: ["tipo de cliente"],
  sale_type: ["tipo de venta"],
  source: ["fuente lead"],
  country: ["país", "pais"],
};
const ORG_FIELD_NAME_INDUSTRY = ["industria"];

const norm = (s) => (s || "").toString().toLowerCase().trim();

function optionsArray(field) {
  if (!field || !Array.isArray(field.options)) return [];
  return field.options.map((o) => ({ id: String(o.id), label: o.label }));
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const auth = await verifyUser(req);
  if (!auth.ok) { res.status(auth.status).json({ ok: false, error: auth.error }); return; }

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

  // ---- Descubrir campos de lista por nombre ----
  async function discoverFields() {
    const out = { vertical: null, client_type: null, sale_type: null, source: null, country: null, industry: null, notFound: [] };
    const df = (await pd("/dealFields", { limit: "500" })).data || [];
    for (const f of df) {
      const n = norm(f.name);
      for (const [col, names] of Object.entries(DEAL_FIELD_NAMES)) {
        if (names.includes(n)) out[col] = { key: f.key, name: f.name, type: f.field_type, options: optionsArray(f) };
      }
    }
    try {
      const of = (await pd("/organizationFields", { limit: "500" })).data || [];
      const found = of.find((f) => ORG_FIELD_NAME_INDUSTRY.includes(norm(f.name)));
      if (found) out.industry = { key: found.key, name: found.name, type: found.field_type, options: optionsArray(found) };
    } catch (e) { /* org fields opcional */ }
    ["vertical", "client_type", "sale_type", "source", "country", "industry"].forEach((c) => { if (!out[c]) out.notFound.push(c); });
    return out;
  }

  // ---- Debug: solo el mapeo de campos ----
  if (debugFields) {
    try {
      const f = await discoverFields();
      const describe = (x) => x ? { name: x.name, key: x.key, type: x.type, opciones: x.options } : "NO ENCONTRADO";
      res.status(200).json({
        ok: true,
        campos: {
          Vertical: describe(f.vertical),
          "Tipo de cliente": describe(f.client_type),
          "Tipo de Venta": describe(f.sale_type),
          "Fuente lead": describe(f.source),
          "País": describe(f.country),
          "Industria (organización)": describe(f.industry),
        },
        faltantes: f.notFound,
      });
    } catch (e) {
      res.status(502).json({ ok: false, error: String(e && e.message ? e.message : e) });
    }
    return;
  }

  try {
    // 1) Campos de lista + opciones
    const fields = await discoverFields();

    // 2) Organizaciones (id + nombre), paginado, alfabético
    const orgs = [];
    let s = 0;
    for (let g = 0; g < 200; g++) {
      const j = await pd("/organizations", { limit: "500", start: String(s), sort: "name ASC" });
      (j.data || []).forEach((o) => { if (o && o.id) orgs.push({ id: o.id, name: (o.name || "").toString() }); });
      const pag = j.additional_data && j.additional_data.pagination;
      if (pag && pag.more_items_in_collection) s = pag.next_start; else break;
    }
    orgs.sort((a, b) => a.name.localeCompare(b.name, "es", { sensitivity: "base" }));

    // 3) Partners → user_id. Prioridad: env override → usuarios de Pipedrive.
    const partnerNames = (process.env.PIPEDRIVE_ALLOWED_OWNERS
      ? process.env.PIPEDRIVE_ALLOWED_OWNERS.split(",")
      : DEFAULT_PARTNERS).map((x) => x.trim()).filter(Boolean).filter((x) => !/^\d+$/.test(x));

    const envMap = {}; // norm(nombre) → userId
    if (process.env.PIPEDRIVE_PARTNER_USERS) {
      process.env.PIPEDRIVE_PARTNER_USERS.split(",").forEach((pair) => {
        const i = pair.lastIndexOf(":");
        if (i > 0) {
          const nm = norm(pair.slice(0, i));
          const id = pair.slice(i + 1).trim();
          if (nm && /^\d+$/.test(id)) envMap[nm] = Number(id);
        }
      });
    }

    // Usuarios activos de Pipedrive (para resolver por nombre exacto).
    const userByName = {};
    try {
      const uj = await pd("/users");
      (uj.data || []).forEach((u) => { if (u && u.name) userByName[norm(u.name)] = u.id; });
    } catch (e) { /* si falla, quedará el envMap y lo resuelve create en runtime */ }

    const partners = partnerNames.map((name) => {
      const k = norm(name);
      const userId = (envMap[k] != null) ? envMap[k] : (userByName[k] != null ? userByName[k] : null);
      return { name, userId };
    });

    res.status(200).json({
      ok: true,
      pipeline: ALLOWED_PIPELINE,
      fields: {
        vertical: fields.vertical ? fields.vertical.options : [],
        client_type: fields.client_type ? fields.client_type.options : [],
        sale_type: fields.sale_type ? fields.sale_type.options : [],
        source: fields.source ? fields.source.options : [],
        country: fields.country ? fields.country.options : [],
        industry: fields.industry ? fields.industry.options : [],
      },
      fieldsFound: {
        vertical: !!fields.vertical, client_type: !!fields.client_type, sale_type: !!fields.sale_type,
        source: !!fields.source, country: !!fields.country, industry: !!fields.industry,
      },
      organizations: orgs,
      partners,
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
}

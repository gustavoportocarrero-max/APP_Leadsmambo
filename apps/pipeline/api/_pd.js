// ============================================================
// mambo · Pipeline — cliente y descubrimiento de campos de Pipedrive (compartido)
//
// Módulo auxiliar ("_" → no es ruta). Lo usa my-pending.js para escribir campos.
// Descubre por NOMBRE las claves internas (hashes por cuenta) de los campos de
// lista y arma el mapa etiqueta→id de opción para poder escribir.
// ============================================================

const norm = (s) => (s || "").toString().toLowerCase().trim();
const COMBINING = new RegExp("[\\u0300-\\u036f]", "g");
const stripAccents = (s) => norm(s).normalize("NFD").replace(COMBINING, "");

const DEAL_FIELD_NAMES = {
  vertical: ["vertical"],
  client_type: ["tipo de cliente"],
  sale_type: ["tipo de venta"],
  source: ["fuente lead"],
  country: ["país", "pais"],
};
const ORG_FIELD_NAME_INDUSTRY = ["industria"];

export function pdEnv() {
  const token = process.env.PIPEDRIVE_API_TOKEN;
  const domain = process.env.PIPEDRIVE_COMPANY_DOMAIN;
  const base = domain ? `https://${domain}.pipedrive.com/api/v1` : "https://api.pipedrive.com/v1";
  return { token, base };
}

export function makePd(token, base) {
  const url = (path, params = {}) => {
    const u = new URL(base + path);
    u.searchParams.set("api_token", token);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  };
  return {
    get: async (path, params) => {
      const r = await fetch(url(path, params));
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.success === false) throw new Error(`Pipedrive GET ${path} → HTTP ${r.status}`);
      return j;
    },
    put: async (path, body) => {
      const r = await fetch(url(path), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.success === false) throw new Error(`Pipedrive PUT ${path} → HTTP ${r.status} ${JSON.stringify(j.error || "")}`);
      return j.data;
    },
    post: async (path, body) => {
      const r = await fetch(url(path), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.success === false || !j.data) throw new Error(`Pipedrive POST ${path} → HTTP ${r.status} ${JSON.stringify(j.error || "")}`);
      return j.data;
    },
  };
}

function optMap(field) {
  const m = {};
  if (field && Array.isArray(field.options)) {
    field.options.forEach((o) => { m[norm(o.label)] = String(o.id); m[stripAccents(o.label)] = String(o.id); });
  }
  return m;
}

// Descubre claves + mapas etiqueta→id de los campos de lista (negocio) e Industria (org).
export async function discoverFields(pd) {
  const keys = { vertical: null, client_type: null, sale_type: null, source: null, country: null };
  const opts = {};
  const df = (await pd.get("/dealFields", { limit: "500" })).data || [];
  for (const f of df) {
    const n = norm(f.name);
    for (const [col, names] of Object.entries(DEAL_FIELD_NAMES)) {
      if (names.includes(n)) { keys[col] = f.key; opts[col] = optMap(f); }
    }
  }
  let industryKey = null, industryOpts = null;
  try {
    const of = (await pd.get("/organizationFields", { limit: "500" })).data || [];
    const found = of.find((f) => ORG_FIELD_NAME_INDUSTRY.includes(norm(f.name)));
    if (found) { industryKey = found.key; industryOpts = optMap(found); }
  } catch (_) { /* opcional */ }
  return { keys, opts, industryKey, industryOpts };
}

// Traduce etiqueta (texto visible) → id de opción, tolerante a acentos. null si no existe.
export function labelToId(optionMap, text) {
  if (!optionMap) return null;
  const t = (text || "").toString().trim();
  if (!t) return null;
  return optionMap[norm(t)] || optionMap[stripAccents(t)] || null;
}

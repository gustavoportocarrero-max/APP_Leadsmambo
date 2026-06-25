// ============================================================
// mambo - Pipeline piloto Peru
// Catalogos + datos de arranque para MODO DEMO (sin Supabase).
//
// IMPORTANTE: SEED_DEALS aqui es FICTICIO, solo para el modo demo (fallback
// cuando Supabase no esta configurado). La fuente de verdad real es Supabase.
// No poner datos reales de clientes en este archivo (el repo los versiona).
//
// Modelo: { id, pipedriveId, org, title, owner, stage, amount, prob, vertical,
//           clientType, industry, source, closeDate, comment, status, lossReason }
// ============================================================

const SEED_DEALS = [
  { id: 1, pipedriveId: null, org: "Empresa Demo Uno",    title: "Demo - Planeamiento cultural",      owner: "Mauricio",         stage: "target",    amount: 30000, prob: 25,   vertical: "Cultura, Talento & Liderazgo", clientType: "Cliente nuevo",   industry: "", source: "Demo", closeDate: "", comment: "", status: "activo", lossReason: "" },
  { id: 2, pipedriveId: null, org: "Empresa Demo Dos",    title: "Demo - Coaching de liderazgo",      owner: "Mauricio",         stage: "cierre",    amount: 12000, prob: 75,   vertical: "Cultura, Talento & Liderazgo", clientType: "Cliente actual",  industry: "", source: "Demo", closeDate: "", comment: "", status: "activo", lossReason: "" },
  { id: 3, pipedriveId: null, org: "Empresa Demo Tres",   title: "Demo - Estrategia comercial",       owner: "Guillermo Solano", stage: "contacto",  amount: 20000, prob: 50,   vertical: "Estrategia",                   clientType: "Cliente nuevo",   industry: "", source: "Demo", closeDate: "", comment: "", status: "activo", lossReason: "" },
  { id: 4, pipedriveId: null, org: "Empresa Demo Cuatro", title: "Demo - Marca empleadora",           owner: "Nicolás Aramburú", stage: "primera",   amount: 18000, prob: 25,   vertical: "Marca & Experiencia",          clientType: "Cliente nuevo",   industry: "", source: "Demo", closeDate: "", comment: "", status: "activo", lossReason: "" },
  { id: 5, pipedriveId: null, org: "Empresa Demo Cinco",  title: "Demo - Transformacion digital",     owner: "Renzo Duarte",     stage: "propuesta", amount: 25000, prob: 50,   vertical: "Transformación Digital",       clientType: "Cliente actual",  industry: "", source: "Demo", closeDate: "", comment: "", status: "activo", lossReason: "" },
  { id: 6, pipedriveId: null, org: "Empresa Demo Seis",   title: "Demo - Diagnostico de clima",       owner: "Cristina Mc",      stage: "nurturing", amount: 15000, prob: null, vertical: "Cultura, Talento & Liderazgo", clientType: "Cliente antiguo", industry: "", source: "Demo", closeDate: "", comment: "", status: "activo", lossReason: "" }
];

// Catalogos del modelo
// STAGES es la FUENTE DE VERDAD del orden del pipeline (inicio -> fin).
// Toda la app (selector de etapa, filtros, agrupaciones, resúmenes) recorre
// este arreglo, así que el orden de visualización se define aquí una sola vez.
// Solo se reordena; los nombres y colores de cada etapa no cambian.
const STAGES = [
  { id: "target",    label: "Target",                    bg: "#B7DBF1", text: "#003179" },
  { id: "contacto",  label: "Contacto establecido",      bg: "#1E56CD", text: "#FFFFFF" },
  { id: "primera",   label: "Primera reunión",           bg: "#E7EEFF", text: "#1E56CD" },
  { id: "propuesta", label: "Presentación de propuesta", bg: "#003179", text: "#FFFFFF" },
  { id: "cierre",    label: "Follow-up y cierre",        bg: "#FA5478", text: "#FFFFFF" },
  { id: "nurturing", label: "Nurturing",                 bg: "#DCD7FF", text: "#1D0446" }
];

// Motivos de pérdida: EXACTOS (se envían a Pipedrive como lost_reason tal cual).
const LOSS_REASONS = [
  "Escogieron otro proveedor",
  "Desinterés (dejaron de contestar)",
  "Falta de presupuesto"
];

const SEED_VERSION = "2026-06-25-demo-ficticio";

// Partners del piloto. La lista del selector "¿Quién eres?" es la unión de estos
// con los propietarios que existan en los datos cargados (por si aparece alguno nuevo).
const OWNERS = [
  "Nicolás Aramburú",
  "Renzo Duarte",
  "Cristina Mc",
  "Guillermo Solano",
  "Mauricio",
  "Topless"
];

if (typeof module !== "undefined" && module.exports) {
  module.exports = { SEED_DEALS, STAGES, LOSS_REASONS, SEED_VERSION, OWNERS };
}

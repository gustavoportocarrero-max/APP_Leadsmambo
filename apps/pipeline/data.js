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

// ============================================================
// AUTENTICACIÓN (login con Google vía Supabase Auth)
// ============================================================
// Dominio permitido: solo correos de este dominio pueden entrar.
// (También se puede sobreescribir con la env var ALLOWED_EMAIL_DOMAIN en Vercel,
//  que llega por /api/config; esta constante es el valor por defecto.)
const ALLOWED_DOMAIN = "mambo.pe";

// Mapeo CORREO → PARTNER. La clave (correo) va en minúsculas. El valor debe
// coincidir EXACTO con el nombre del propietario que usa la lógica de edición y el
// filtro (los de OWNERS).
const EMAIL_TO_PARTNER = {
  "na@mambo.pe": "Nicolás Aramburú",
  "rd@mambo.pe": "Renzo Duarte",
  "mau@mambo.pe": "Mauricio",
  "guillermo.solano@mambo.pe": "Guillermo Solano",
  "cristina.mclauchlan@mambo.pe": "Cristina Mc",
};

// ADMINISTRADORES del proyecto (correos en minúsculas). No son partners: ven todo y
// pueden EDITAR cualquier negocio (sin la restricción de "solo lo mío"). Editable aquí
// para agregar/quitar admins en el futuro.
const ADMIN_EMAILS = [
  "gustavo.portocarrero@mambo.pe",
];

// Lista de partners (para el selector de propietario al crear, si eres admin).
// Deriva de EMAIL_TO_PARTNER: los nombres deben coincidir EXACTO con Pipedrive.
const PARTNERS = [...new Set(Object.values(EMAIL_TO_PARTNER))];

// País del negocio: opciones fijas del piloto (solo Perú/Ecuador). El selector
// SIEMPRE ofrece estas dos; la escritura a Pipedrive se hace por nombre de campo.
const COUNTRIES = ["Perú", "Ecuador"];

// ¿El correo pertenece al dominio permitido?
function emailDomainAllowed(email, domain) {
  const d = String(domain || ALLOWED_DOMAIN).toLowerCase().trim();
  return typeof email === "string" && email.toLowerCase().trim().endsWith("@" + d);
}
// Partner asociado a un correo (o "" si no está mapeado → solo lectura).
function partnerForEmail(email) {
  return EMAIL_TO_PARTNER[String(email || "").toLowerCase().trim()] || "";
}
// ¿El correo es administrador?
function isAdmin(email) {
  return ADMIN_EMAILS.map((e) => e.toLowerCase()).includes(String(email || "").toLowerCase().trim());
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    SEED_DEALS, STAGES, LOSS_REASONS, SEED_VERSION, OWNERS,
    ALLOWED_DOMAIN, EMAIL_TO_PARTNER, ADMIN_EMAILS, PARTNERS, COUNTRIES,
    emailDomainAllowed, partnerForEmail, isAdmin,
  };
}

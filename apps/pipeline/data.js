/* ============================================================
   mambo · Pipeline piloto Perú
   16 negocios de ejemplo. Datos FICTICIOS para el piloto.
   En producción: reemplazar por el import real de Pipedrive
   (CSV → mapear columnas al modelo, ver app.js / importCsv).

   Modelo de un negocio:
   {
     id, org, title, owner, stage, amount, prob,
     vertical, clientType, industry, source, closeDate,
     comment, status, lossReason
   }
   ============================================================ */

const SEED_DEALS = [
  { id: 1,  org: "Andes Retail",        title: "Programa de cultura de servicio",        owner: "Lucía Ramos",   stage: "propuesta", amount: 48000, prob: 60,   vertical: "Cultura y talento", clientType: "Corporativo",     industry: "Retail",         source: "Referido", closeDate: "2026-07-15", comment: "", status: "activo", lossReason: "" },
  { id: 2,  org: "Banco Litoral",       title: "Estrategia de marca empleadora",          owner: "Diego Fuentes", stage: "contacto",  amount: 72000, prob: 40,   vertical: "Marketing",         clientType: "Corporativo",     industry: "Banca",          source: "Inbound",  closeDate: "2026-08-01", comment: "", status: "activo", lossReason: "" },
  { id: 3,  org: "Minera Sol",          title: "Diagnóstico de clima organizacional",     owner: "Lucía Ramos",   stage: "cierre",    amount: 35000, prob: 85,   vertical: "Cultura y talento", clientType: "Corporativo",     industry: "Minería",        source: "Evento",   closeDate: "2026-06-25", comment: "", status: "activo", lossReason: "" },
  { id: 4,  org: "Café del Valle",      title: "Rediseño de propuesta de valor",          owner: "Mateo Salas",   stage: "primera",   amount: 18000, prob: 25,   vertical: "Estrategia",        clientType: "Mediana empresa", industry: "Alimentos",      source: "Outbound", closeDate: "2026-09-10", comment: "", status: "activo", lossReason: "" },
  { id: 5,  org: "TechNova",            title: "Habilitación comercial B2B",              owner: "Diego Fuentes", stage: "propuesta", amount: 56000, prob: 55,   vertical: "Ventas",            clientType: "Mediana empresa", industry: "Software",       source: "Inbound",  closeDate: "2026-07-30", comment: "", status: "activo", lossReason: "" },
  { id: 6,  org: "Clínica San Borja",   title: "Plan de transformación digital",          owner: "Mateo Salas",   stage: "target",    amount: 90000, prob: null, vertical: "Tecnología",        clientType: "Corporativo",     industry: "Salud",          source: "Referido", closeDate: "",           comment: "", status: "activo", lossReason: "" },
  { id: 7,  org: "Logística Pacífico",  title: "Mapeo de cultura post-fusión",            owner: "Lucía Ramos",   stage: "primera",   amount: 41000, prob: 30,   vertical: "Cultura y talento", clientType: "Corporativo",     industry: "Logística",      source: "Evento",   closeDate: "2026-08-20", comment: "", status: "activo", lossReason: "" },
  { id: 8,  org: "EduFuturo",           title: "Estrategia de crecimiento 2027",          owner: "Mateo Salas",   stage: "contacto",  amount: 27000, prob: 45,   vertical: "Estrategia",        clientType: "Mediana empresa", industry: "Educación",      source: "Inbound",  closeDate: "2026-09-05", comment: "", status: "activo", lossReason: "" },
  { id: 9,  org: "Seguros Cumbre",      title: "Rebranding institucional",                owner: "Diego Fuentes", stage: "cierre",    amount: 64000, prob: 80,   vertical: "Marketing",         clientType: "Corporativo",     industry: "Seguros",        source: "Referido", closeDate: "2026-06-30", comment: "", status: "activo", lossReason: "" },
  { id: 10, org: "AgroSur",             title: "Modelo de gestión por OKRs",              owner: "Lucía Ramos",   stage: "nurturing", amount: 22000, prob: 15,   vertical: "Estrategia",        clientType: "Mediana empresa", industry: "Agroindustria",  source: "Outbound", closeDate: "",           comment: "", status: "activo", lossReason: "" },
  { id: 11, org: "Constructora Lima",   title: "Programa de liderazgo de obra",           owner: "Mateo Salas",   stage: "propuesta", amount: 38000, prob: 50,   vertical: "Cultura y talento", clientType: "Corporativo",     industry: "Construcción",   source: "Evento",   closeDate: "2026-07-22", comment: "", status: "activo", lossReason: "" },
  { id: 12, org: "Telecom Andina",      title: "Customer journey y experiencia",          owner: "Diego Fuentes", stage: "target",    amount: 110000, prob: null,vertical: "Marketing",         clientType: "Corporativo",     industry: "Telecom",        source: "Inbound",  closeDate: "",           comment: "", status: "activo", lossReason: "" },
  { id: 13, org: "Mercado Norte",       title: "Playbook de ventas retail",               owner: "Lucía Ramos",   stage: "contacto",  amount: 31000, prob: 35,   vertical: "Ventas",            clientType: "Mediana empresa", industry: "Retail",         source: "Outbound", closeDate: "2026-08-12", comment: "", status: "activo", lossReason: "" },
  { id: 14, org: "FinTech Río",         title: "Cultura ágil para escalar",               owner: "Mateo Salas",   stage: "primera",   amount: 47000, prob: 40,   vertical: "Cultura y talento", clientType: "Mediana empresa", industry: "Fintech",        source: "Referido", closeDate: "2026-09-18", comment: "", status: "activo", lossReason: "" },
  { id: 15, org: "Hotelera Costa",      title: "Plataforma de datos comerciales",         owner: "Diego Fuentes", stage: "nurturing", amount: 53000, prob: 20,   vertical: "Tecnología",        clientType: "Corporativo",     industry: "Hotelería",      source: "Evento",   closeDate: "",           comment: "", status: "activo", lossReason: "" },
  { id: 16, org: "Distribuidora Inca",  title: "Optimización de fuerza de ventas",        owner: "Lucía Ramos",   stage: "propuesta", amount: 29000, prob: 55,   vertical: "Ventas",            clientType: "Mediana empresa", industry: "Distribución",   source: "Inbound",  closeDate: "2026-07-08", comment: "", status: "activo", lossReason: "" }
];

// Catálogos del modelo
const STAGES = [
  { id: "target",    label: "Target",                    bg: "#B7DBF1", text: "#003179" },
  { id: "primera",   label: "Primera reunión",           bg: "#E7EEFF", text: "#1E56CD" },
  { id: "contacto",  label: "Contacto establecido",      bg: "#1E56CD", text: "#FFFFFF" },
  { id: "propuesta", label: "Presentación de propuesta", bg: "#003179", text: "#FFFFFF" },
  { id: "cierre",    label: "Follow-up y cierre",        bg: "#FA5478", text: "#FFFFFF" },
  { id: "nurturing", label: "Nurturing",                 bg: "#DCD7FF", text: "#1D0446" }
];

const LOSS_REASONS = [
  "Precio / presupuesto",
  "Eligió a un competidor",
  "No es el momento",
  "Sin respuesta / se enfrió",
  "Cambio de prioridades",
  "No calificaba (mal fit)"
];

if (typeof module !== "undefined" && module.exports) {
  module.exports = { SEED_DEALS, STAGES, LOSS_REASONS };
}

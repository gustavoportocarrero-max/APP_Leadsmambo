// ============================================================
// mambo · Pipeline — helpers de "semana de seguimiento" (hora Perú)
//
// Módulo auxiliar (prefijo "_" → no es ruta en Vercel). Lo usan los endpoints
// de recordatorios (weekly-email) y de estado (weekly-status).
//
// DEFINICIÓN DE SEMANA: de LUNES 00:00 a MIÉRCOLES 6:00 PM, hora Perú.
// Perú es UTC-5 fijo (no tiene horario de verano), así que usamos ese offset.
//
// Env opcionales:
//   PIPEDRIVE_ALLOWED_OWNERS  → (si existe) redefine la lista de partners.
//   PARTNER_EMAILS            → "Nombre:correo,Nombre2:correo2" (override de correos).
// ============================================================

export const PERU_OFFSET_MIN = -300; // UTC-5

// Los 5 partners (deben coincidir con los nombres de propietario).
export const DEFAULT_PARTNERS = ["Nicolás Aramburú", "Renzo Duarte", "Mauricio", "Guillermo Solano", "Cristina Mc"];

// Correos por partner (override con PARTNER_EMAILS). Son correos internos del
// equipo; no son datos de clientes.
const DEFAULT_PARTNER_EMAILS = {
  "Nicolás Aramburú": "na@mambo.pe",
  "Renzo Duarte": "rd@mambo.pe",
  "Mauricio": "mau@mambo.pe",
  "Guillermo Solano": "guillermo.solano@mambo.pe",
  "Cristina Mc": "cristina.mclauchlan@mambo.pe",
};

const norm = (s) => (s || "").toString().toLowerCase().trim();

export function partners() {
  const raw = process.env.PIPEDRIVE_ALLOWED_OWNERS
    ? process.env.PIPEDRIVE_ALLOWED_OWNERS.split(",").map((s) => s.trim()).filter((s) => s && !/^\d+$/.test(s))
    : DEFAULT_PARTNERS.slice();
  return raw.length ? raw : DEFAULT_PARTNERS.slice();
}

// Partner (nombre) para un correo, o "" si el correo no es de un partner (p.ej. admin).
export function partnerForEmail(email) {
  const e = norm(email);
  const map = partnerEmails();
  for (const [name, addr] of Object.entries(map)) if (norm(addr) === e) return name;
  return "";
}

export function partnerEmails() {
  const map = { ...DEFAULT_PARTNER_EMAILS };
  if (process.env.PARTNER_EMAILS) {
    process.env.PARTNER_EMAILS.split(",").forEach((pair) => {
      const i = pair.lastIndexOf(":");
      if (i > 0) {
        const name = pair.slice(0, i).trim();
        const email = pair.slice(i + 1).trim();
        if (name && email) map[name] = email;
      }
    });
  }
  return map;
}

// ---- Fechas en hora Perú (offset fijo -5) ----
// "Reloj de pared" de Perú: desplazamos el instante y luego leemos con getUTC*.
function peruWall(nowMs) { return new Date(nowMs + PERU_OFFSET_MIN * 60000); }

// Lunes de la semana actual (hora Perú), como "YYYY-MM-DD".
export function weekStartStr(nowMs = Date.now()) {
  const w = peruWall(nowMs);
  const day = w.getUTCDay();                 // 0=dom … 6=sáb (en hora Perú)
  const diff = day === 0 ? 6 : day - 1;      // días desde el lunes
  const mon = new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate() - diff));
  const y = mon.getUTCFullYear();
  const m = String(mon.getUTCMonth() + 1).padStart(2, "0");
  const d = String(mon.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Mes actual en hora Perú, como "YYYY-MM" (para comparar con la fecha de cierre).
export function peruYearMonth(nowMs = Date.now()) {
  const w = peruWall(nowMs);
  return `${w.getUTCFullYear()}-${String(w.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Instante (ms UTC) de un momento de ESTA semana en hora Perú:
//   daysFromMonday: 0=lunes, 2=miércoles … ; hour/min = hora de pared en Perú.
export function weekMomentMs(nowMs, daysFromMonday, hour, min) {
  const w = peruWall(nowMs);
  const day = w.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  // Medianoche del lunes (Perú) como partes de pared:
  const y = w.getUTCFullYear(), mo = w.getUTCMonth(), d = w.getUTCDate() - diff + daysFromMonday;
  // Pared Perú → instante UTC: instante = Date.UTC(pared) - offset
  return Date.UTC(y, mo, d, hour, min, 0) - PERU_OFFSET_MIN * 60000;
}

export function mondayStartMs(nowMs = Date.now()) { return weekMomentMs(nowMs, 0, 0, 0); }
export function wed6pmMs(nowMs = Date.now()) { return weekMomentMs(nowMs, 2, 18, 0); }

// Mes en curso en hora Perú, como "YYYY-MM".
export function peruYearMonth(nowMs = Date.now()) {
  const w = peruWall(nowMs);
  return `${w.getUTCFullYear()}-${String(w.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ---- Cumplimiento ----
// Un partner CUMPLE si editó al menos una vez en la ventana (activity_log) O
// confirmó "Sí" en la revisión de la semana.
//   activityRows: filas de activity_log ya filtradas por la ventana de tiempo.
//   reviewRows:   filas de weekly_review de la semana (week_start).
export function computeCompliance(list, activityRows, reviewRows, emails) {
  const editedActors = new Set((activityRows || []).map((r) => norm(r.actor)));
  const editedEmails = new Set((activityRows || []).map((r) => norm(r.actor_email)).filter(Boolean));
  const confirmedBy = new Set((reviewRows || []).filter((r) => r.confirmed).map((r) => norm(r.partner)));
  return list.map((p) => {
    const email = (emails && emails[p]) || "";
    const edited = editedActors.has(norm(p)) || (email && editedEmails.has(norm(email)));
    const confirmed = confirmedBy.has(norm(p));
    return { partner: p, email, edited: !!edited, confirmed, ok: !!edited || confirmed };
  });
}

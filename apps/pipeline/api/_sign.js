// ============================================================
// mambo · Pipeline — tokens firmados (HMAC) para enlaces de correo
//
// Módulo auxiliar ("_" → no es ruta). El correo de leads calientes lleva un
// enlace "Sin novedades" que se abre SIN sesión; el token firmado identifica al
// partner + semana de forma que no se pueda falsificar (se firma con CRON_SECRET).
//
// Formato: base64url(payload) + "." + base64url(HMAC-SHA256(base64url(payload))).
// payload = "partner|week".
// ============================================================

import crypto from "crypto";

function hmac(data) {
  const secret = process.env.CRON_SECRET || "";
  return crypto.createHmac("sha256", secret).update(data).digest("base64url");
}

export function signPartnerWeek(partner, week) {
  const b64 = Buffer.from(`${partner}|${week}`, "utf8").toString("base64url");
  return `${b64}.${hmac(b64)}`;
}

// Devuelve { partner, week } si el token es válido; null si no.
export function verifyPartnerWeek(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [b64, sig] = parts;
  const expect = hmac(b64);
  if (sig.length !== expect.length) return null;
  let ok = false;
  try { ok = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect)); } catch (_) { return null; }
  if (!ok) return null;
  const payload = Buffer.from(b64, "base64url").toString("utf8");
  const idx = payload.lastIndexOf("|");
  if (idx <= 0) return null;
  const partner = payload.slice(0, idx);
  const week = payload.slice(idx + 1);
  if (!partner || !week) return null;
  return { partner, week };
}

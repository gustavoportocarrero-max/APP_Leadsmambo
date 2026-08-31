// ============================================================
// mambo · Pipeline — "SIN NOVEDADES" de leads calientes (landing del correo)
//
// GET público (sin sesión): lo abre el partner desde el botón "Sin novedades"
// del correo de leads calientes. La autenticidad la da el TOKEN FIRMADO en la URL
// (?t=…), que identifica partner + semana (ver _sign.js). Al abrirse:
//   - registra en hot_leads_review que el partner marcó "sin novedades" esa semana,
//   - muestra una página de confirmación simple.
//
// Env: CRON_SECRET (clave de firma), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_URL (opc).
// ============================================================

import { verifyPartnerWeek } from "./_sign.js";

const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const APP_BASE = () => process.env.APP_URL || "https://app-leadsmambo.vercel.app";

function page(title, bodyHtml) {
  return `<!doctype html><html lang="es"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
<style>
  body{margin:0;font-family:Arial,Helvetica,sans-serif;background:#1D0446;color:#1D0446;
       display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
  .card{background:#fff;border-radius:18px;max-width:420px;width:100%;padding:32px 28px;text-align:center;
        box-shadow:0 12px 40px rgba(0,0,0,.25)}
  .check{width:64px;height:64px;border-radius:50%;background:#EAF7EE;color:#1a7f37;display:grid;place-items:center;
         font-size:34px;margin:0 auto 18px}
  .bad{background:#FDECEF;color:#c0143c}
  h1{font-size:20px;margin:0 0 8px}
  p{font-size:15px;line-height:1.5;color:#3a3350;margin:0 0 8px}
  .muted{color:#6B6582;font-size:13px}
  a.btn{display:inline-block;margin-top:18px;background:#FA5478;color:#fff;text-decoration:none;
        border-radius:10px;padding:11px 18px;font-weight:700;font-size:14px}
</style></head><body><div class="card">${bodyHtml}</div></body></html>`;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  const token = (req.query && (req.query.t || req.query.token)) || "";
  const data = verifyPartnerWeek(token);
  if (!data) {
    res.status(403).send(page("Enlace inválido", `
      <div class="check bad">✕</div>
      <h1>Enlace inválido o expirado</h1>
      <p>No pudimos validar este enlace. Ábrelo desde el correo más reciente de leads calientes.</p>
      <a class="btn" href="${esc(APP_BASE())}/">Ir a la app</a>`));
    return;
  }

  const { partner, week } = data;
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) {
    res.status(500).send(page("Error", `
      <div class="check bad">!</div><h1>Configuración incompleta</h1>
      <p>No se pudo registrar (faltan credenciales de la base). Avisa al administrador.</p>`));
    return;
  }

  try {
    const r = await fetch(`${sbUrl}/rest/v1/hot_leads_review?on_conflict=partner,week_start`, {
      method: "POST",
      headers: {
        apikey: sbKey, Authorization: `Bearer ${sbKey}`, "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({ partner, week_start: week, acked: true, acked_at: new Date().toISOString() }),
    });
    if (!r.ok) throw new Error(`Supabase HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);

    console.log("[hot-leads-ack]", JSON.stringify({ partner, week, ok: true }));
    res.status(200).send(page("Registrado", `
      <div class="check">✓</div>
      <h1>Listo, registrado sin novedades ✓</h1>
      <p>Gracias, ${esc(partner)}. Anotamos que no hay novedades con tus leads calientes de esta semana.</p>
      <p class="muted">Si luego sí hay una novedad, entra a la app y actualiza el negocio.</p>
      <a class="btn" href="${esc(APP_BASE())}/">Abrir la app</a>`));
  } catch (e) {
    console.error("[hot-leads-ack] ERROR", String(e && e.message ? e.message : e));
    res.status(502).send(page("Error", `
      <div class="check bad">!</div><h1>No se pudo registrar</h1>
      <p>Intenta de nuevo en un momento, o entra a la app y actualiza tus leads.</p>
      <a class="btn" href="${esc(APP_BASE())}/">Ir a la app</a>`));
  }
}

// ============================================================
// mambo · Pipeline — RECORDATORIOS POR CORREO (Resend)
//
// Cron externo (cron-job.org), protegido con CRON_SECRET. Dos modos:
//   ?mode=all      → MARTES 11am: correo a los 5 partners (recordatorio general).
//   ?mode=pending  → MIÉRCOLES 11am: correo SOLO a quienes NO han cumplido en la
//                    ventana lunes→ahora (no editaron en activity_log Y no
//                    confirmaron "Sí"). A quienes ya cumplieron, no les llega.
//
// Tono de urgencia con alerta roja 🚨.
//
// Variables de entorno:
//   CRON_SECRET                (requerida) protege el endpoint
//   RESEND_API_KEY             (requerida) API key de Resend
//   RESEND_FROM                (requerida) remitente verificado, ej.
//                              "Mambo Pipeline <pipeline@tudominio.com>"
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (requeridas solo para mode=pending)
//   PARTNER_EMAILS             (opcional) override de correos por partner
//   PIPEDRIVE_ALLOWED_OWNERS   (opcional) override de la lista de partners
//
// Manual: GET /api/weekly-email?key=<CRON_SECRET>&mode=all   (o mode=pending)
//         Agrega &dry=1 para NO enviar (solo ver a quién se enviaría).
// ============================================================

import { partners, partnerEmails, weekStartStr, mondayStartMs, computeCompliance } from "./_week.js";

const SUBJECT = "🚨 ACTUALIZA TU BASE 🚨";

function emailHtml(partnerName) {
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1D0446">
    <div style="background:#FA5478;color:#fff;border-radius:14px;padding:18px 20px;text-align:center">
      <div style="font-size:22px;font-weight:800;letter-spacing:.5px">🚨 ACTUALIZA TU BASE 🚨</div>
    </div>
    <p style="font-size:16px;line-height:1.5;margin:22px 0 8px">Hola ${partnerName || ""} 👋</p>
    <p style="font-size:16px;line-height:1.5;margin:0 0 16px">
      Es momento de <b>actualizar tu base de Pipedrive</b>, porque si no
      <b>el reporte de la semana estará desactualizado</b>. 📉
    </p>
    <p style="font-size:15px;line-height:1.5;margin:0 0 20px">
      Entra a la app, revisa tus negocios y, cuando termines, pulsa
      <b>"Terminé de revisar"</b> para dejar constancia. ✅
    </p>
    <p style="font-size:13px;color:#6B6582;margin:24px 0 0">— mambo · pipeline</p>
  </div>`;
}

async function sendEmail(apiKey, from, to, subject, html) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Resend HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || "";
  const key = (req.query && req.query.key) || "";
  if (!secret || (auth !== `Bearer ${secret}` && key !== secret)) {
    res.status(401).json({ ok: false, error: "No autorizado (falta CRON_SECRET correcto)." });
    return;
  }

  const mode = (req.query && req.query.mode) === "pending" ? "pending" : "all";
  const dry = req.query && req.query.dry === "1";

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!dry && (!apiKey || !from)) {
    res.status(500).json({ ok: false, error: "Faltan RESEND_API_KEY / RESEND_FROM." });
    return;
  }

  const list = partners();
  const emails = partnerEmails();
  const weekStart = weekStartStr();

  try {
    // A quién enviar
    let recipients = list.slice();

    if (mode === "pending") {
      const sbUrl = process.env.SUPABASE_URL;
      const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!sbUrl || !sbKey) { res.status(500).json({ ok: false, error: "Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (mode=pending)." }); return; }
      const sbHeaders = { apikey: sbKey, Authorization: `Bearer ${sbKey}` };

      const mondayIso = new Date(mondayStartMs()).toISOString();
      const [aRes, wRes] = await Promise.all([
        fetch(`${sbUrl}/rest/v1/activity_log?created_at=gte.${encodeURIComponent(mondayIso)}&select=actor,actor_email&limit=5000`, { headers: sbHeaders }),
        fetch(`${sbUrl}/rest/v1/weekly_review?week_start=eq.${weekStart}&select=partner,confirmed`, { headers: sbHeaders }),
      ]);
      if (!aRes.ok) throw new Error(`Supabase activity_log → HTTP ${aRes.status}`);
      if (!wRes.ok) throw new Error(`Supabase weekly_review → HTTP ${wRes.status}`);
      const activityRows = await aRes.json();
      const reviewRows = await wRes.json();

      const compliance = computeCompliance(list, activityRows, reviewRows, emails);
      recipients = compliance.filter((c) => !c.ok).map((c) => c.partner);
    }

    // Enviar (o simular)
    const sent = [], failed = [], skipped = [];
    for (const p of recipients) {
      const to = emails[p];
      if (!to) { skipped.push({ partner: p, reason: "sin correo" }); continue; }
      if (dry) { sent.push({ partner: p, to, dry: true }); continue; }
      try { await sendEmail(apiKey, from, to, SUBJECT, emailHtml(p)); sent.push({ partner: p, to }); }
      catch (e) { failed.push({ partner: p, to, error: String(e && e.message ? e.message : e) }); }
    }

    const summary = {
      ok: failed.length === 0,
      mode, semana: weekStart, dry: !!dry,
      destinatarios: recipients,
      enviados: sent.length, fallidos: failed.length, sin_correo: skipped.length,
      detalle: { sent, failed, skipped },
    };
    console.log("[weekly-email]", JSON.stringify({ ...summary, detalle: undefined }));
    res.status(summary.ok ? 200 : 502).json(summary);
  } catch (e) {
    const fail = { ok: false, error: String(e && e.message ? e.message : e) };
    console.error("[weekly-email] ERROR", JSON.stringify(fail));
    res.status(502).json(fail);
  }
}

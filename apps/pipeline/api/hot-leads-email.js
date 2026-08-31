// ============================================================
// mambo · Pipeline — CORREO DE LEADS CALIENTES (SMTP Gmail)
//
// Cron externo (cron-job.org) MIÉRCOLES 5:30 PM Perú, protegido con CRON_SECRET.
// Distinto de weekly-email: enfoca los leads "calientes" de cada partner.
//
// Un negocio entra si cumple LOS TRES a la vez (pipeline 1, del propio partner):
//   1) probabilidad >= 75%
//   2) fecha de cierre prevista dentro del MES EN CURSO (hora Perú). Las fechas se
//      guardan como último día del mes, así que basta comparar "YYYY-MM".
//   3) etapa = "Follow-up y cierre" (stage_id 55).
// Si un partner no tiene ninguno, NO se le envía correo.
//
// Idempotencia (mode "hot-leads" en weekly_email_sent): un correo por partner por
// semana; reintentos del cron no duplican. testTo la ignora (para pruebas).
//
// Variables de entorno:
//   CRON_SECRET, GMAIL_USER, GMAIL_APP_PASSWORD, SMTP_PORT (opc),
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (idempotencia),
//   PIPEDRIVE_API_TOKEN, PIPEDRIVE_COMPANY_DOMAIN (opc),
//   PARTNER_EMAILS (opc), PIPEDRIVE_ALLOWED_OWNERS (opc),
//   APP_URL (opc), PIPEDRIVE_URL (opc).
//
// Manual: GET /api/hot-leads-email?key=<CRON_SECRET>
//         &dry=1          → no envía ni reserva (muestra leads y a quién iría).
//         &testTo=correo  → todo va a ese correo (con etiqueta del partner); ignora idempotencia.
//         &force=1        → reenvía aunque ya se haya enviado esta semana.
// ============================================================

import { makeTransport, escHtml as esc } from "./_mail.js";
import { partners, partnerEmails, weekStartStr, peruYearMonth } from "./_week.js";
import { pdEnv, makePd } from "./_pd.js";
import { fetchHotLeadsByPartner } from "./_hotleads.js";
import { signPartnerWeek } from "./_sign.js";

const EMAIL_MODE = "hot-leads";
const APP_BASE = () => process.env.APP_URL || "https://app-leadsmambo.vercel.app";

// ackUrl = enlace firmado "Sin novedades"; appUrl = "Actualizar" (vista principal).
function leadEmailHtml(partnerName, leads, ackUrl, testForLabel) {
  const q = leads.length === 1
    ? "¿Hay alguna novedad con respecto al siguiente lead?"
    : "¿Hay alguna novedad con respecto a alguno de los siguientes leads?";
  const items = leads.map((l) =>
    `<li style="margin:10px 0;line-height:1.45">
       <b>${esc(l.title)}</b>${l.org ? ` <span style="color:#6B6582">· ${esc(l.org)}</span>` : ""}<br/>
       <span style="color:#6B6582;font-size:13px">Cierre previsto: ${esc(l.closeLabel)} · ${esc(l.money)}</span>
     </li>`).join("");
  const testBanner = testForLabel
    ? `<div style="background:#FFF3CD;color:#7a5c00;border:1px solid #ffe08a;border-radius:10px;padding:10px 14px;margin:0 0 16px;font-size:13px;font-weight:700">🧪 PRUEBA — este correo era originalmente para: ${esc(testForLabel)}</div>`
    : "";
  const appUrl = APP_BASE();

  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1D0446">
    ${testBanner}
    <div style="background:#1D0446;color:#fff;border-radius:14px;padding:18px 20px;border-left:6px solid #FA5478">
      <div style="font-size:19px;font-weight:800;letter-spacing:.3px">🔥 Leads a seguir de cerca</div>
      <div style="font-size:13px;opacity:.85;margin-top:4px">Alta probabilidad y cierre previsto este mes</div>
    </div>
    <p style="font-size:16px;line-height:1.5;margin:22px 0 6px">Hola ${esc(partnerName)} 👋</p>
    <p style="font-size:16px;font-weight:700;line-height:1.5;margin:0 0 12px">${q}</p>
    <ul style="padding-left:18px;margin:0 0 18px">${items}</ul>
    <p style="font-size:14px;line-height:1.55;margin:0 0 20px;color:#3a3350">
      Son leads clave: conviene mantener su información al día. Si hay alguna novedad,
      pulsa <b>Actualizar</b> y edítalo en la app. Si no hay nada nuevo con ninguno,
      pulsa <b>Sin novedades</b> para dejar constancia.
    </p>
    <div style="margin:0 0 8px">
      <a href="${esc(ackUrl)}" style="display:inline-block;background:#1D0446;color:#fff;text-decoration:none;border-radius:10px;padding:11px 18px;font-weight:700;font-size:14px;margin:0 8px 8px 0">Sin novedades ✓</a>
      <a href="${esc(appUrl)}/" style="display:inline-block;background:#FA5478;color:#fff;text-decoration:none;border-radius:10px;padding:11px 18px;font-weight:700;font-size:14px;margin:0 8px 8px 0">Actualizar →</a>
    </div>
    <p style="font-size:13px;color:#6B6582;margin:18px 0 0">Mantente pendiente por si hay respuesta o novedad de parte del lead.</p>
    <p style="font-size:13px;color:#6B6582;margin:20px 0 0">— mambo · pipeline</p>
  </div>`;
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

  const dry = req.query && req.query.dry === "1";
  const force = req.query && req.query.force === "1";
  const testTo = (req.query && req.query.testTo) ? String(req.query.testTo).trim() : "";
  if (testTo && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(testTo)) {
    res.status(400).json({ ok: false, error: `testTo no parece un correo válido: ${testTo}` });
    return;
  }

  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  if (!dry && (!gmailUser || !gmailPass)) {
    res.status(500).json({ ok: false, error: "Faltan GMAIL_USER / GMAIL_APP_PASSWORD." });
    return;
  }
  const from = `"Mambo Pipeline" <${gmailUser}>`;

  const { token, base } = pdEnv();
  if (!token) { res.status(500).json({ ok: false, error: "Falta PIPEDRIVE_API_TOKEN." }); return; }
  const pd = makePd(token, base);

  const list = partners();
  const emails = partnerEmails();
  const weekStart = weekStartStr();
  const ym = peruYearMonth();

  // Supabase para idempotencia (no aplica en dry ni testTo).
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const needSupabase = !dry && !testTo;
  if (needSupabase && (!sbUrl || !sbKey)) {
    res.status(500).json({ ok: false, error: "Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY." });
    return;
  }
  const sbHeaders = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, "Content-Type": "application/json" };
  async function reserve(p) {
    const r = await fetch(`${sbUrl}/rest/v1/weekly_email_sent?on_conflict=partner,week_start,mode`, {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify({ partner: p, week_start: weekStart, mode: EMAIL_MODE }),
    });
    if (!r.ok) throw new Error(`reserva HTTP ${r.status}`);
    const rows = await r.json().catch(() => []);
    return Array.isArray(rows) && rows.length > 0;
  }
  async function unreserve(p) {
    try {
      await fetch(`${sbUrl}/rest/v1/weekly_email_sent?partner=eq.${encodeURIComponent(p)}&week_start=eq.${weekStart}&mode=eq.${EMAIL_MODE}`,
        { method: "DELETE", headers: sbHeaders });
    } catch (_) { /* best-effort */ }
  }

  try {
    // 1) Leads calientes por partner (criterio compartido con el reporte).
    const byPartner = await fetchHotLeadsByPartner(pd, list, ym);

    // 2) Destinatarios = partners con al menos un lead caliente.
    const recipients = list.filter((p) => byPartner[p].length > 0);

    // 3) Enviar (o simular), con idempotencia.
    const transporter = dry ? null : makeTransport(gmailUser, gmailPass);
    const sent = [], failed = [], skipped = [];
    try {
      for (const p of recipients) {
        const to = testTo || emails[p];
        if (!to) { skipped.push({ partner: p, reason: "sin correo" }); continue; }
        if (dry) { sent.push({ partner: p, to, para_original: p, leads: byPartner[p].length, dry: true }); continue; }

        if (!testTo) {
          if (force) await unreserve(p);
          let reserved;
          try { reserved = await reserve(p); }
          catch (e) { failed.push({ partner: p, to, error: "reserva: " + (e.message || e) }); continue; }
          if (!reserved) { skipped.push({ partner: p, reason: "ya enviado esta semana (idempotencia)" }); continue; }
        }

        const subject = testTo ? `[PRUEBA — originalmente para: ${p}] 🔥 Tus leads calientes` : "🔥 Tus leads calientes — cierre este mes";
        // Enlace firmado "Sin novedades": identifica al partner + semana sin sesión.
        const ackUrl = `${APP_BASE()}/api/hot-leads-ack?t=${encodeURIComponent(signPartnerWeek(p, weekStart))}`;
        try {
          await transporter.sendMail({ from, to, subject, html: leadEmailHtml(p, byPartner[p], ackUrl, testTo ? p : null) });
          sent.push({ partner: p, to, leads: byPartner[p].length });
        } catch (e) {
          if (!testTo) await unreserve(p);
          failed.push({ partner: p, to, error: String(e && e.message ? e.message : e) });
        }
      }
    } finally {
      if (transporter) try { transporter.close(); } catch (_) {}
    }

    const summary = {
      ok: failed.length === 0,
      tipo: "hot-leads", semana: weekStart, mes: ym, dry: !!dry, force: !!force,
      testTo: testTo || undefined,
      con_leads: recipients,
      enviados: sent.length, fallidos: failed.length, omitidos: skipped.length,
      leads_por_partner: dry ? byPartner : undefined,
      detalle: { sent, failed, skipped },
    };
    console.log("[hot-leads-email]", JSON.stringify({ ...summary, detalle: undefined, leads_por_partner: undefined }));
    res.status(summary.ok ? 200 : 502).json(summary);
  } catch (e) {
    const fail = { ok: false, error: String(e && e.message ? e.message : e) };
    console.error("[hot-leads-email] ERROR", JSON.stringify(fail));
    res.status(502).json(fail);
  }
}

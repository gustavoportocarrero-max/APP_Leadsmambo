// ============================================================
// mambo · Pipeline — LEADS CALIENTES (endpoint unificado)
//
// Un solo archivo (una función serverless) que atiende 3 acciones vía ?action=:
//   action=email   → correo de leads calientes (cron miércoles 5:30pm). CRON_SECRET.
//   action=status  → reporte a Slack (cron jueves 6pm). CRON_SECRET.
//   action=ack     → landing pública "Sin novedades" (enlace firmado del correo).
//
// Se unificaron hot-leads-email/status/ack para no exceder el límite de funciones
// serverless del plan Hobby de Vercel. La lógica de cada acción es la misma de antes.
//
// Lead caliente (pipeline 1, del propio partner): prob >= 75, etapa "Follow-up y
// cierre" (stage 55) y cierre previsto en el mes en curso (hora Perú).
//
// Env: CRON_SECRET, GMAIL_USER, GMAIL_APP_PASSWORD, SMTP_PORT (opc),
//      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SLACK_WEBHOOK_URL,
//      PIPEDRIVE_API_TOKEN, PIPEDRIVE_COMPANY_DOMAIN (opc),
//      PARTNER_EMAILS (opc), PIPEDRIVE_ALLOWED_OWNERS (opc), APP_URL (opc).
//
// Manual:
//   /api/hot-leads?action=email&key=<CRON_SECRET>   (&dry=1 &testTo=correo &force=1)
//   /api/hot-leads?action=status&key=<CRON_SECRET>  (&dry=1 &testWebhook=<url>)
//   /api/hot-leads?action=ack&t=<token>             (lo abre el partner desde el correo)
// ============================================================

import { makeTransport, escHtml as esc } from "./_mail.js";
import { partners, partnerEmails, weekStartStr, mondayStartMs, peruYearMonth } from "./_week.js";
import { pdEnv, makePd } from "./_pd.js";
import { fetchHotLeadsByPartner } from "./_hotleads.js";
import { signPartnerWeek, verifyPartnerWeek } from "./_sign.js";

const EMAIL_MODE = "hot-leads";
const APP_BASE = () => process.env.APP_URL || "https://app-leadsmambo.vercel.app";
const norm = (s) => (s || "").toString().toLowerCase().trim();

function requireCron(req, res) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || "";
  const key = (req.query && req.query.key) || "";
  if (!secret || (auth !== `Bearer ${secret}` && key !== secret)) {
    res.status(401).json({ ok: false, error: "No autorizado (falta CRON_SECRET correcto)." });
    return false;
  }
  return true;
}

/* ============================================================
   action=email — correo de leads calientes
   ============================================================ */
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

async function handleEmail(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!requireCron(req, res)) return;

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
    const byPartner = await fetchHotLeadsByPartner(pd, list, ym);
    const recipients = list.filter((p) => byPartner[p].length > 0);

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
        const ackUrl = `${APP_BASE()}/api/hot-leads?action=ack&t=${encodeURIComponent(signPartnerWeek(p, weekStart))}`;
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
    console.log("[hot-leads:email]", JSON.stringify({ ...summary, detalle: undefined, leads_por_partner: undefined }));
    res.status(summary.ok ? 200 : 502).json(summary);
  } catch (e) {
    const fail = { ok: false, error: String(e && e.message ? e.message : e) };
    console.error("[hot-leads:email] ERROR", JSON.stringify(fail));
    res.status(502).json(fail);
  }
}

/* ============================================================
   action=status — reporte a Slack (jueves 6pm)
   ============================================================ */
async function handleStatus(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!requireCron(req, res)) return;

  const dry = req.query && req.query.dry === "1";
  const testWebhook = (req.query && req.query.testWebhook) ? String(req.query.testWebhook).trim() : "";
  const slack = testWebhook || process.env.SLACK_WEBHOOK_URL;

  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) { res.status(500).json({ ok: false, error: "Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY." }); return; }
  if (!slack && !dry) { res.status(500).json({ ok: false, error: "Falta SLACK_WEBHOOK_URL." }); return; }

  const { token, base } = pdEnv();
  if (!token) { res.status(500).json({ ok: false, error: "Falta PIPEDRIVE_API_TOKEN." }); return; }
  const pd = makePd(token, base);

  const list = partners();
  const emails = partnerEmails();
  const week = weekStartStr();
  const ym = peruYearMonth();
  const sbHeaders = { apikey: sbKey, Authorization: `Bearer ${sbKey}` };

  try {
    const byPartner = await fetchHotLeadsByPartner(pd, list, ym);

    const ar = await fetch(`${sbUrl}/rest/v1/hot_leads_review?week_start=eq.${week}&acked=is.true&select=partner`, { headers: sbHeaders });
    if (!ar.ok) throw new Error(`Supabase hot_leads_review → HTTP ${ar.status}`);
    const acked = new Set((await ar.json()).map((r) => norm(r.partner)));

    const mondayIso = new Date(mondayStartMs()).toISOString();
    const actRes = await fetch(`${sbUrl}/rest/v1/activity_log?created_at=gte.${encodeURIComponent(mondayIso)}&select=actor,actor_email,pipedrive_id&limit=5000`, { headers: sbHeaders });
    if (!actRes.ok) throw new Error(`Supabase activity_log → HTTP ${actRes.status}`);
    const activity = await actRes.json();

    const estado = list.map((p) => {
      const leads = byPartner[p] || [];
      if (leads.length === 0) return { partner: p, tenia: false, ok: null, edito: false, acked: false, leads: 0 };
      const hotIds = new Set(leads.map((l) => Number(l.id)));
      const pe = norm(emails[p] || "");
      const edito = activity.some((r) =>
        (norm(r.actor) === norm(p) || (pe && norm(r.actor_email) === pe)) &&
        r.pipedrive_id != null && hotIds.has(Number(r.pipedrive_id)));
      const ack = acked.has(norm(p));
      return { partner: p, tenia: true, ok: ack || edito, edito, acked: ack, leads: leads.length };
    });

    const lines = [`🔥 *Reporte de Leads Calientes — semana del ${week}*`, ""];
    estado.forEach((e) => {
      if (!e.tenia) lines.push(`${e.partner} — _sin leads calientes esta semana_`);
      else lines.push(`${e.partner} ${e.ok ? "✅" : "❌"}`);
    });
    const conLeads = estado.filter((e) => e.tenia);
    const cumplen = conLeads.filter((e) => e.ok).length;
    lines.push("");
    lines.push(`_${cumplen} de ${conLeads.length} partners con leads calientes los atendieron._`);
    const text = lines.join("\n");

    let slackOk = true;
    if (!dry) {
      const sr = await fetch(slack, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      slackOk = sr.ok;
    }

    const summary = {
      ok: slackOk, tipo: "hot-leads-status", semana: week, mes: ym, dry: !!dry,
      con_leads: conLeads.length, cumplen,
      estado: estado.map((e) => ({ partner: e.partner, tenia: e.tenia, ok: e.ok, edito: e.edito, acked: e.acked, leads: e.leads })),
      slack: dry ? "no enviado (dry)" : (slackOk ? "enviado" : "error"),
      preview: text,
    };
    console.log("[hot-leads:status]", JSON.stringify({ ...summary, preview: undefined }));
    res.status(slackOk ? 200 : 502).json(summary);
  } catch (e) {
    const fail = { ok: false, error: String(e && e.message ? e.message : e) };
    console.error("[hot-leads:status] ERROR", JSON.stringify(fail));
    res.status(502).json(fail);
  }
}

/* ============================================================
   action=ack — landing pública "Sin novedades" (enlace firmado)
   ============================================================ */
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

async function handleAck(req, res) {
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

    console.log("[hot-leads:ack]", JSON.stringify({ partner, week, ok: true }));
    res.status(200).send(page("Registrado", `
      <div class="check">✓</div>
      <h1>Listo, registrado sin novedades ✓</h1>
      <p>Gracias, ${esc(partner)}. Anotamos que no hay novedades con tus leads calientes de esta semana.</p>
      <p class="muted">Si luego sí hay una novedad, entra a la app y actualiza el negocio.</p>
      <a class="btn" href="${esc(APP_BASE())}/">Abrir la app</a>`));
  } catch (e) {
    console.error("[hot-leads:ack] ERROR", String(e && e.message ? e.message : e));
    res.status(502).send(page("Error", `
      <div class="check bad">!</div><h1>No se pudo registrar</h1>
      <p>Intenta de nuevo en un momento, o entra a la app y actualiza tus leads.</p>
      <a class="btn" href="${esc(APP_BASE())}/">Ir a la app</a>`));
  }
}

/* ============================================================
   Dispatcher
   ============================================================ */
export default async function handler(req, res) {
  const action = (req.query && req.query.action) || "";
  if (action === "ack") return handleAck(req, res);
  if (action === "email") return handleEmail(req, res);
  if (action === "status") return handleStatus(req, res);
  res.setHeader("Cache-Control", "no-store");
  res.status(400).json({ ok: false, error: "Falta ?action=email|status|ack" });
}

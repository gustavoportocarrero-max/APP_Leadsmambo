// ============================================================
// mambo · Pipeline — REPORTE DE LEADS CALIENTES A SLACK (jueves 6pm Perú)
//
// Cron externo (cron-job.org), protegido con CRON_SECRET. Distinto del reporte de
// estado semanal (weekly-status): título propio "🔥 Reporte de Leads Calientes".
//
// Por cada partner que TENÍA leads calientes esta semana, ✅ si:
//   - dio "Sin novedades" (hot_leads_review.acked), O
//   - editó al menos uno de sus leads calientes en la app (activity_log de la
//     semana cruzado con los ids de sus leads calientes).
//   Si no hizo ninguna → ❌. Si no tenía leads calientes → "— sin leads…".
//
// Env: CRON_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SLACK_WEBHOOK_URL,
//      PIPEDRIVE_API_TOKEN, PIPEDRIVE_COMPANY_DOMAIN (opc), PARTNER_EMAILS (opc),
//      PIPEDRIVE_ALLOWED_OWNERS (opc).
//
// Manual: GET /api/hot-leads-status?key=<CRON_SECRET>
//         &dry=1               → calcula pero NO publica (muestra el preview).
//         &testWebhook=<url>   → publica a ese webhook en vez del oficial.
// ============================================================

import { partners, partnerEmails, weekStartStr, mondayStartMs, peruYearMonth } from "./_week.js";
import { pdEnv, makePd } from "./_pd.js";
import { fetchHotLeadsByPartner } from "./_hotleads.js";

const norm = (s) => (s || "").toString().toLowerCase().trim();

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
    // 1) Leads calientes por partner (mismo criterio que el correo).
    const byPartner = await fetchHotLeadsByPartner(pd, list, ym);

    // 2) Quién dio "Sin novedades" esta semana.
    const ar = await fetch(`${sbUrl}/rest/v1/hot_leads_review?week_start=eq.${week}&acked=is.true&select=partner`, { headers: sbHeaders });
    if (!ar.ok) throw new Error(`Supabase hot_leads_review → HTTP ${ar.status}`);
    const acked = new Set((await ar.json()).map((r) => norm(r.partner)));

    // 3) Actividad de la semana (para "editó un lead caliente").
    const mondayIso = new Date(mondayStartMs()).toISOString();
    const actRes = await fetch(`${sbUrl}/rest/v1/activity_log?created_at=gte.${encodeURIComponent(mondayIso)}&select=actor,actor_email,pipedrive_id&limit=5000`, { headers: sbHeaders });
    if (!actRes.ok) throw new Error(`Supabase activity_log → HTTP ${actRes.status}`);
    const activity = await actRes.json();

    // 4) Estado por partner.
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

    // 5) Mensaje Slack (título distinto al reporte de estado semanal).
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
    console.log("[hot-leads-status]", JSON.stringify({ ...summary, preview: undefined }));
    res.status(slackOk ? 200 : 502).json(summary);
  } catch (e) {
    const fail = { ok: false, error: String(e && e.message ? e.message : e) };
    console.error("[hot-leads-status] ERROR", JSON.stringify(fail));
    res.status(502).json(fail);
  }
}

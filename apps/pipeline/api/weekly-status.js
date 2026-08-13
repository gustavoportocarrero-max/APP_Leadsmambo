// ============================================================
// mambo · Pipeline — ESTADO SEMANAL A SLACK (✅/❌)
//
// Cron externo (cron-job.org) MIÉRCOLES 6:00 PM Perú, protegido con CRON_SECRET.
// Publica al canal la lista de los 5 partners con ✅ o ❌:
//   ✅ si editó al menos una vez entre LUNES 00:00 y MIÉRCOLES 6:00 PM
//      (según activity_log)  O  dio "Sí" en "Terminé de revisar" esa semana.
//   ❌ si no hizo ninguna de las dos.
//
// Es distinto del reporte de adopción (weekly-report.js): este es el semáforo
// de cumplimiento de cara al reporte del viernes.
//
// Variables de entorno:
//   CRON_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SLACK_WEBHOOK_URL
//   PARTNER_EMAILS (opcional), PIPEDRIVE_ALLOWED_OWNERS (opcional)
//
// Manual: GET /api/weekly-status?key=<CRON_SECRET>   (&dry=1 para no publicar)
// ============================================================

import { partners, partnerEmails, weekStartStr, mondayStartMs, wed6pmMs, computeCompliance } from "./_week.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || "";
  const key = (req.query && req.query.key) || "";
  if (!secret || (auth !== `Bearer ${secret}` && key !== secret)) {
    res.status(401).json({ ok: false, error: "No autorizado (falta CRON_SECRET correcto)." });
    return;
  }

  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const slack = process.env.SLACK_WEBHOOK_URL;
  if (!sbUrl || !sbKey) { res.status(500).json({ ok: false, error: "Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY." }); return; }
  const dry = req.query && req.query.dry === "1";
  if (!slack && !dry) { res.status(500).json({ ok: false, error: "Falta SLACK_WEBHOOK_URL." }); return; }

  const list = partners();
  const emails = partnerEmails();
  const weekStart = weekStartStr();
  const sbHeaders = { apikey: sbKey, Authorization: `Bearer ${sbKey}` };

  try {
    // Ventana: lunes 00:00 → miércoles 6:00 PM (Perú). Si se corre después, se
    // respeta el corte del miércoles 6pm (no cuenta actividad posterior).
    const mondayIso = new Date(mondayStartMs()).toISOString();
    const cutoffIso = new Date(wed6pmMs()).toISOString();

    const [aRes, wRes] = await Promise.all([
      fetch(`${sbUrl}/rest/v1/activity_log?created_at=gte.${encodeURIComponent(mondayIso)}&created_at=lte.${encodeURIComponent(cutoffIso)}&select=actor,actor_email&limit=5000`, { headers: sbHeaders }),
      fetch(`${sbUrl}/rest/v1/weekly_review?week_start=eq.${weekStart}&select=partner,confirmed`, { headers: sbHeaders }),
    ]);
    if (!aRes.ok) throw new Error(`Supabase activity_log → HTTP ${aRes.status}`);
    if (!wRes.ok) throw new Error(`Supabase weekly_review → HTTP ${wRes.status}`);
    const activityRows = await aRes.json();
    const reviewRows = await wRes.json();

    const compliance = computeCompliance(list, activityRows, reviewRows, emails);

    // Mensaje simple: nombre + ✅/❌
    const lines = ["Guti, te adjunto quienes cumplieron con las modificaciones esta semana:"];
    compliance.forEach((c) => lines.push(`${c.partner} ${c.ok ? "✅" : "❌"}`));
    const cumplen = compliance.filter((c) => c.ok).length;
    const text = lines.join("\n");

    let slackOk = true;
    if (!dry) {
      const sr = await fetch(slack, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      slackOk = sr.ok;
    }

    const summary = {
      ok: slackOk, semana: weekStart, dry: !!dry,
      cumplen, total: list.length,
      estado: compliance.map((c) => ({ partner: c.partner, ok: c.ok, edito: c.edited, confirmo: c.confirmed })),
      slack: dry ? "no enviado (dry)" : (slackOk ? "enviado" : "error"),
      preview: text,
    };
    console.log("[weekly-status]", JSON.stringify({ ...summary, preview: undefined }));
    res.status(slackOk ? 200 : 502).json(summary);
  } catch (e) {
    const fail = { ok: false, error: String(e && e.message ? e.message : e) };
    console.error("[weekly-status] ERROR", JSON.stringify(fail));
    res.status(502).json(fail);
  }
}

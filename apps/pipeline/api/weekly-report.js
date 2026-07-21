// ============================================================
// mambo · Pipeline — REPORTE DE ACTIVIDAD A SLACK
//
// Se llama por cron externo (cron-job.org) martes y jueves 7pm Perú, o manual.
// Reúne los cambios hechos EN LA APP (tabla activity_log) por partner + un
// resumen REFERENCIAL de cambios recientes en Pipedrive (pipeline 1), arma un
// mensaje y lo publica en Slack (Incoming Webhook).
//
// Objetivo principal: medir ADOPCIÓN (quién usó la app y quién no).
//
// Variables de entorno:
//   CRON_SECRET                (requerida) protege el endpoint (misma que el pull)
//   SUPABASE_URL               (requerida)
//   SUPABASE_SERVICE_ROLE_KEY  (requerida) para leer activity_log server-side
//   SLACK_WEBHOOK_URL          (requerida) Incoming Webhook del canal destino
//   PIPEDRIVE_API_TOKEN        (opcional)  para el bloque referencial de Pipedrive
//   PIPEDRIVE_COMPANY_DOMAIN   (opcional)
//
// Manual: GET /api/weekly-report?key=<CRON_SECRET>   (opcional &days=4)
// ============================================================

const ALLOWED_PIPELINE = 1;
// Los 5 partners (editable). Deben coincidir con los nombres de propietario.
const PARTNERS = ["Nicolás Aramburú", "Renzo Duarte", "Mauricio", "Guillermo Solano", "Cristina Mc"];

function fmtMoney(n) { return "US$" + (Number(n) || 0).toLocaleString("en-US"); }

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
  if (!slack) { res.status(500).json({ ok: false, error: "Falta SLACK_WEBHOOK_URL." }); return; }

  const days = Math.min(Math.max(parseInt((req.query && req.query.days) || "4", 10) || 4, 1), 31);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const sinceIso = since.toISOString();

  try {
    // 1) Actividad EN LA APP desde `since`
    const r = await fetch(
      `${sbUrl}/rest/v1/activity_log?created_at=gte.${encodeURIComponent(sinceIso)}&order=created_at.desc&select=actor,actor_email,org,title,field,new_value,created_at&limit=2000`,
      { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` } }
    );
    if (!r.ok) throw new Error(`Supabase activity_log → HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    const rows = await r.json();

    const byActor = {};
    rows.forEach((row) => {
      const a = row.actor || "(desconocido)";
      (byActor[a] = byActor[a] || []).push(row);
    });

    // 2) Referencial: cambios recientes en Pipedrive (pipeline 1) por propietario
    let pdRef = null; // { [owner]: count } o null si no disponible
    const token = process.env.PIPEDRIVE_API_TOKEN;
    if (token) {
      try {
        const domain = process.env.PIPEDRIVE_COMPANY_DOMAIN;
        const base = domain ? `https://${domain}.pipedrive.com/api/v1` : "https://api.pipedrive.com/v1";
        const counts = {};
        let start = 0;
        for (let g = 0; g < 60; g++) {
          const u = new URL(`${base}/pipelines/${ALLOWED_PIPELINE}/deals`);
          u.searchParams.set("api_token", token);
          u.searchParams.set("status", "all_not_deleted");
          u.searchParams.set("limit", "100");
          u.searchParams.set("start", String(start));
          const pr = await fetch(u.toString());
          const pj = await pr.json().catch(() => ({}));
          if (!pr.ok || pj.success === false) throw new Error("Pipedrive HTTP " + pr.status);
          (pj.data || []).forEach((d) => {
            const owner = (d.owner_name || (d.user_id && d.user_id.name) || "").toString();
            if (!PARTNERS.includes(owner)) return;
            const ut = d.update_time ? new Date(d.update_time.replace(" ", "T") + "Z") : null;
            if (ut && ut >= since) counts[owner] = (counts[owner] || 0) + 1;
          });
          const pag = pj.additional_data && pj.additional_data.pagination;
          if (pag && pag.more_items_in_collection) start = pag.next_start; else break;
        }
        pdRef = counts;
      } catch (e) {
        pdRef = null; // referencial: si falla, se omite con nota
      }
    }

    // 3) Armar el mensaje para Slack (mrkdwn)
    const lines = [];
    lines.push("📊 *Reporte de actividad — mambo Pipeline*");
    lines.push(`_Últimos ${days} días · adopción de la app_`);
    lines.push("");
    lines.push("*Uso de la app por partner:*");
    let activos = 0;
    PARTNERS.forEach((p) => {
      const list = byActor[p] || [];
      if (list.length) {
        activos++;
        lines.push(`✅ *${p}* — ${list.length} cambio${list.length === 1 ? "" : "s"}`);
        list.slice(0, 5).forEach((row) => {
          const negocio = row.title || row.org || "(negocio)";
          lines.push(`     • ${negocio}: ${row.field} → ${row.new_value}`);
        });
        if (list.length > 5) lines.push(`     • …y ${list.length - 5} más`);
      } else {
        lines.push(`⚠️ *${p}* — _Sin actividad esta semana_`);
      }
      delete byActor[p];
    });
    lines.push("");
    lines.push(`_Resumen: ${activos} de ${PARTNERS.length} partners usaron la app._`);

    // Otros actores (admin / correos sin mapear) que hayan tenido actividad
    const otros = Object.keys(byActor);
    if (otros.length) {
      lines.push("");
      lines.push("*Otros usuarios de la app:*");
      otros.forEach((a) => lines.push(`     • ${a}: ${byActor[a].length} cambio(s)`));
    }

    // Bloque referencial de Pipedrive
    lines.push("");
    lines.push("*Referencial — cambios vistos en Pipedrive (pipeline 1):*");
    lines.push("_Indicativo: no distingue quién hizo el cambio ni si fue por la app._");
    if (pdRef) {
      const anyPd = PARTNERS.some((p) => pdRef[p]);
      if (anyPd) PARTNERS.forEach((p) => { if (pdRef[p]) lines.push(`     • ${p}: ${pdRef[p]} negocio(s) con cambios recientes`); });
      else lines.push("     • Sin cambios recientes detectados.");
    } else {
      lines.push("     • (No disponible en esta corrida.)");
    }

    const text = lines.join("\n");

    // 4) Enviar a Slack
    const sr = await fetch(slack, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const slackOk = sr.ok;

    const summary = {
      ok: slackOk,
      dias: days,
      desde: sinceIso,
      cambios_app: rows.length,
      partners_activos: activos,
      partners_total: PARTNERS.length,
      pipedrive_referencial: pdRef ? "disponible" : "no disponible",
      slack: slackOk ? "enviado" : ("error HTTP " + sr.status),
    };
    console.log("[weekly-report]", JSON.stringify(summary));
    res.status(slackOk ? 200 : 502).json(summary);
  } catch (e) {
    const fail = { ok: false, error: String(e && e.message ? e.message : e) };
    console.error("[weekly-report] ERROR", JSON.stringify(fail));
    res.status(502).json(fail);
  }
}

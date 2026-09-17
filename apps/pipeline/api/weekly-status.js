// ============================================================
// mambo · Pipeline — ESTADO SEMANAL A SLACK (✅/❌)
//
// Cron externo (cron-job.org) MIÉRCOLES 6:00 PM Perú, protegido con CRON_SECRET.
// Publica al canal la lista de los 5 partners con ✅/❌ y el ORIGEN. Ventana:
// LUNES 00:00 → MIÉRCOLES 6:00 PM (Perú). Un partner cumple por TRES vías:
//   (app)       editó en la app (activity_log) o confirmó "Sí" en "Terminé de revisar".
//   (Pipedrive) alguno de SUS negocios (pipeline 1) tiene update_time en la ventana
//               y NO fue tocado por la app esa semana (ver anti-eco abajo).
//   ✅ (app) / ✅ (Pipedrive) / ✅ (app + Pipedrive) / ❌ / — sin evaluar.
//
// ANTI-ECO (falsos positivos): la app solo escribe a Pipedrive en las EDICIONES
// (el pull de 2h es de lectura), y cada escritura queda en activity_log con su
// pipedrive_id. Por eso, un update_time reciente NO cuenta como origen Pipedrive
// si ese negocio tiene actividad de la app esa semana. Limitación conocida: no
// se consulta el changelog por-usuario de Pipedrive (sería 1 llamada por negocio),
// así que si un humano y la app tocan EL MISMO negocio la misma semana, ese
// negocio se atribuye a la app (no a Pipedrive).
//
// Es distinto del reporte de adopción (weekly-report.js) y del de leads calientes.
//
// Variables de entorno:
//   CRON_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SLACK_WEBHOOK_URL,
//   PIPEDRIVE_API_TOKEN (para la vía Pipedrive), PIPEDRIVE_COMPANY_DOMAIN (opc),
//   PARTNER_EMAILS (opcional), PIPEDRIVE_ALLOWED_OWNERS (opcional)
//
// Manual: GET /api/weekly-status?key=<CRON_SECRET>   (&dry=1 para no publicar)
// ============================================================

import { partners, partnerEmails, weekStartStr, mondayStartMs, wed6pmMs, computeCompliance } from "./_week.js";
import { pdEnv, makePd } from "./_pd.js";

const ALLOWED_PIPELINE = 1;
const norm = (s) => (s || "").toString().toLowerCase().trim();
const ownerNameOf = (d) => (d.owner_name || (d.user_id && d.user_id.name) || "").toString();

// Negocios del pipeline 1 modificados desde `startMs` (orden update_time desc;
// corta al encontrar uno más viejo que la ventana → solo trae la porción reciente).
async function fetchRecentP1(pd, startMs) {
  const out = []; let s = 0;
  for (let g = 0; g < 100; g++) {
    const j = await pd.get(`/pipelines/${ALLOWED_PIPELINE}/deals`, { status: "all_not_deleted", sort: "update_time DESC", limit: "100", start: String(s) });
    const rows = j.data || [];
    let stop = false;
    for (const d of rows) {
      if (Number(d.pipeline_id) !== ALLOWED_PIPELINE) continue;
      const ut = d.update_time ? Date.parse(d.update_time.replace(" ", "T") + "Z") : NaN;
      if (!Number.isNaN(ut) && ut < startMs) { stop = true; break; }
      out.push(d);
    }
    if (stop) break;
    const pag = j.additional_data && j.additional_data.pagination;
    if (pag && pag.more_items_in_collection) s = pag.next_start; else break;
  }
  return out;
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
      fetch(`${sbUrl}/rest/v1/activity_log?created_at=gte.${encodeURIComponent(mondayIso)}&created_at=lte.${encodeURIComponent(cutoffIso)}&select=actor,actor_email,pipedrive_id&limit=5000`, { headers: sbHeaders }),
      fetch(`${sbUrl}/rest/v1/weekly_review?week_start=eq.${weekStart}&select=partner,confirmed`, { headers: sbHeaders }),
    ]);
    if (!aRes.ok) throw new Error(`Supabase activity_log → HTTP ${aRes.status}`);
    if (!wRes.ok) throw new Error(`Supabase weekly_review → HTTP ${wRes.status}`);
    const activityRows = await aRes.json();
    const reviewRows = await wRes.json();

    // Vía app (edición en app o confirmación con el botón).
    const compliance = computeCompliance(list, activityRows, reviewRows, emails);

    // Vía Pipedrive (cambio directo): update_time en la ventana, excluyendo ecos de
    // la app (negocios que la app tocó esa semana, según activity_log.pipedrive_id).
    // Best-effort: si Pipedrive no responde, se marca "sin evaluar" y NO rompe el reporte.
    const partnerByNorm = {}; list.forEach((p) => { partnerByNorm[norm(p)] = p; });
    const pdChanged = {}; list.forEach((p) => { pdChanged[p] = false; });
    let pdError = null;
    try {
      const { token, base } = pdEnv();
      if (!token) throw new Error("Falta PIPEDRIVE_API_TOKEN.");
      const pd = makePd(token, base);
      const startMs = mondayStartMs(), endMs = wed6pmMs();
      const appWritten = new Set(activityRows.filter((r) => r.pipedrive_id != null).map((r) => Number(r.pipedrive_id)));
      const deals = await fetchRecentP1(pd, startMs);
      for (const d of deals) {
        const p = partnerByNorm[norm(ownerNameOf(d))];
        if (!p) continue;
        const ut = d.update_time ? Date.parse(d.update_time.replace(" ", "T") + "Z") : NaN;
        if (Number.isNaN(ut) || ut < startMs || ut > endMs) continue;
        if (appWritten.has(Number(d.id))) continue; // eco de la propia app → no cuenta
        pdChanged[p] = true;
      }
    } catch (e) {
      pdError = String(e && e.message ? e.message : e);
      console.warn("[weekly-status] Pipedrive no disponible:", pdError);
    }

    // Estado + etiqueta de origen por partner.
    const estado = compliance.map((c) => {
      const app = !!(c.edited || c.confirmed);
      const pdv = !!pdChanged[c.partner];
      let label, origen, ok;
      if (pdError && !app) { label = "— sin evaluar (Pipedrive no disponible)"; origen = "sin_evaluar"; ok = null; }
      else if (app && pdv) { label = "✅ (app + Pipedrive)"; origen = "app+pipedrive"; ok = true; }
      else if (app) { label = "✅ (app)"; origen = "app"; ok = true; }
      else if (pdv) { label = "✅ (Pipedrive)"; origen = "pipedrive"; ok = true; }
      else { label = "❌"; origen = "ninguno"; ok = false; }
      return { partner: c.partner, label, origen, ok, edito: c.edited, confirmo: c.confirmed, pipedrive: pdv };
    });

    const lines = ["Guti, te adjunto quienes cumplieron con las modificaciones esta semana:"];
    estado.forEach((e) => lines.push(`${e.partner} ${e.label}`));
    if (pdError) lines.push("", "⚠️ No se pudo consultar Pipedrive esta vez; el origen Pipedrive quedó sin evaluar.");
    const cumplen = estado.filter((e) => e.ok === true).length;
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
      pipedrive: pdError ? ("no disponible: " + pdError) : "consultado",
      estado: estado.map((e) => ({ partner: e.partner, ok: e.ok, origen: e.origen, edito: e.edito, confirmo: e.confirmo, pipedrive: e.pipedrive })),
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

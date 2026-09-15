// ============================================================
// mambo · Pipeline — alertas del sistema (token de Pipedrive caído)
//
// Módulo auxiliar ("_" → no es ruta). Lo llaman los procesos que tocan Pipedrive
// (pipedrive-pull, pipedrive-sync) cuando reciben HTTP 401 (token inválido) o
// cuando una llamada vuelve a funcionar. Manda un correo a la admin y guarda el
// estado en Supabase (system_alerts) para NO repetir la alerta cada 2 horas.
//
// Todo es BEST-EFFORT: nunca lanza; si Supabase o el correo fallan, solo loguea.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GMAIL_USER, GMAIL_APP_PASSWORD,
//      SMTP_PORT (opc), ALERT_EMAIL (opc; destino, por defecto la admin).
// ============================================================

import { makeTransport } from "./_mail.js";

const KEY = "pipedrive_token";
const DEFAULT_TO = "gustavo.portocarrero@mambo.pe";

function sbEnv() {
  return { sbUrl: process.env.SUPABASE_URL, sbKey: process.env.SUPABASE_SERVICE_ROLE_KEY };
}

async function getState(sbUrl, sbKey) {
  const r = await fetch(`${sbUrl}/rest/v1/system_alerts?key=eq.${KEY}&select=state`, {
    headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` },
  });
  if (!r.ok) throw new Error(`Supabase GET system_alerts → HTTP ${r.status}`);
  const rows = await r.json().catch(() => []);
  return (Array.isArray(rows) && rows[0] && rows[0].state) || "ok";
}

async function setState(sbUrl, sbKey, fields) {
  await fetch(`${sbUrl}/rest/v1/system_alerts?on_conflict=key`, {
    method: "POST",
    headers: {
      apikey: sbKey, Authorization: `Bearer ${sbKey}`, "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ key: KEY, ...fields, updated_at: new Date().toISOString() }),
  });
}

async function sendMail(subject, html) {
  const user = process.env.GMAIL_USER, pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) { console.warn("[alert] sin GMAIL_USER/APP_PASSWORD; no se envía correo"); return false; }
  const to = process.env.ALERT_EMAIL || DEFAULT_TO;
  const t = makeTransport(user, pass);
  try {
    await t.sendMail({ from: `"Mambo Pipeline" <${user}>`, to, subject, html });
    return true;
  } finally { try { t.close(); } catch (_) {} }
}

function downHtml(source) {
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1D0446">
    <div style="background:#c0143c;color:#fff;border-radius:14px;padding:18px 20px">
      <div style="font-size:20px;font-weight:800">⚠️ Token de Pipedrive caído</div>
      <div style="font-size:13px;opacity:.9;margin-top:4px">La app no puede sincronizar con Pipedrive</div>
    </div>
    <p style="font-size:15px;line-height:1.55;margin:20px 0 12px">
      Pipedrive <b>rechazó el token con un error 401</b> (token inválido o revocado),
      detectado en <b>${String(source || "un proceso automático")}</b>.
    </p>
    <p style="font-size:15px;line-height:1.55;margin:0 0 8px"><b>Qué está afectado:</b></p>
    <ul style="font-size:14px;line-height:1.5;margin:0 0 16px;padding-left:18px;color:#3a3350">
      <li>La sincronización con Pipedrive (entrada y salida).</li>
      <li>Los correos automáticos (pueden salir vacíos o incompletos).</li>
      <li>La escritura de cambios de la app hacia Pipedrive.</li>
    </ul>
    <p style="font-size:15px;line-height:1.55;margin:0 0 8px"><b>Qué hacer:</b></p>
    <ol style="font-size:14px;line-height:1.55;margin:0 0 16px;padding-left:18px;color:#3a3350">
      <li>En Pipedrive: Settings → Personal preferences → API → genera / copia el token.</li>
      <li>En Vercel: Project → Settings → Environment Variables → actualiza <b>PIPEDRIVE_API_TOKEN</b>.</li>
      <li>Redeploy (o espera al próximo deploy) para que tome el valor nuevo.</li>
    </ol>
    <p style="font-size:13px;color:#6B6582;margin:16px 0 0">No repetiremos esta alerta hasta que el token se recupere y vuelva a fallar.</p>
    <p style="font-size:13px;color:#6B6582;margin:14px 0 0">— mambo · pipeline</p>
  </div>`;
}

function okHtml() {
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1D0446">
    <div style="background:#1a7f37;color:#fff;border-radius:14px;padding:18px 20px">
      <div style="font-size:20px;font-weight:800">✅ Token de Pipedrive restaurado</div>
    </div>
    <p style="font-size:15px;line-height:1.55;margin:20px 0 0">
      Una llamada a Pipedrive volvió a funcionar: la sincronización quedó operativa de nuevo.
    </p>
    <p style="font-size:13px;color:#6B6582;margin:16px 0 0">— mambo · pipeline</p>
  </div>`;
}

// Llamar cuando un proceso recibe HTTP 401 de Pipedrive. Alerta UNA vez.
export async function pipedriveTokenDown(source) {
  try {
    const { sbUrl, sbKey } = sbEnv();
    if (!sbUrl || !sbKey) { console.warn("[alert] sin Supabase; no se puede registrar estado"); return; }
    const state = await getState(sbUrl, sbKey);
    if (state === "down") return; // ya se alertó; no repetir
    await sendMail("⚠️ Token de Pipedrive caído — la app no puede sincronizar", downHtml(source));
    await setState(sbUrl, sbKey, { state: "down", last_alert_at: new Date().toISOString() });
    console.log("[alert] pipedrive token DOWN — alerta enviada", JSON.stringify({ source }));
  } catch (e) {
    console.error("[alert] pipedriveTokenDown:", String(e && e.message ? e.message : e));
  }
}

// Llamar cuando una llamada a Pipedrive vuelve a funcionar. Si estaba caído,
// avisa la recuperación y resetea el estado.
export async function pipedriveTokenHealthy() {
  try {
    const { sbUrl, sbKey } = sbEnv();
    if (!sbUrl || !sbKey) return;
    const state = await getState(sbUrl, sbKey);
    if (state !== "down") return; // no estaba caído → nada que hacer
    await sendMail("✅ Token de Pipedrive restaurado", okHtml());
    await setState(sbUrl, sbKey, { state: "ok", last_recovery_at: new Date().toISOString() });
    console.log("[alert] pipedrive token RESTAURADO — aviso enviado");
  } catch (e) {
    console.error("[alert] pipedriveTokenHealthy:", String(e && e.message ? e.message : e));
  }
}

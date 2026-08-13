// ============================================================
// mambo · Pipeline — RECORDATORIOS POR CORREO (SMTP Gmail / Google Workspace)
//
// Cron externo (cron-job.org), protegido con CRON_SECRET. Dos modos:
//   ?mode=all      → MARTES 11am: correo a los 5 partners (recordatorio general).
//   ?mode=pending  → MIÉRCOLES 11am: correo SOLO a quienes NO han cumplido en la
//                    ventana lunes→ahora (no editaron en activity_log Y no
//                    confirmaron "Sí"). A quienes ya cumplieron, no les llega.
//
// UN correo por partner por ejecución/semana: se "reserva" (partner, semana, modo)
// en weekly_email_sent ANTES de enviar; si ya estaba reservado (p. ej. un reintento
// de cron-job.org), NO se reenvía. Si el envío falla, se libera la reserva.
//
// Cada correo incluye un RESUMEN PERSONALIZADO con los pendientes reales del
// partner, consultando Pipedrive en vivo (ver _pending.js): negocios antiguos,
// en Follow-up y cierre, y con campos obligatorios incompletos.
//
// Envío por SMTP autenticado del buzón de Google Workspace (nodemailer + pool).
//
// Variables de entorno:
//   CRON_SECRET                (requerida) protege el endpoint
//   GMAIL_USER                 (requerida) correo remitente (ej. gustavo.portocarrero@mambo.pe)
//   GMAIL_APP_PASSWORD         (requerida) contraseña de aplicación de 16 caracteres
//   SMTP_PORT                  (opcional)  465 (SSL, por defecto) o 587 (TLS/STARTTLS)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (requeridas: idempotencia + mode=pending)
//   PIPEDRIVE_API_TOKEN        (opcional)  para el resumen personalizado (si falta, se omite)
//   PIPEDRIVE_COMPANY_DOMAIN   (opcional)
//   PARTNER_EMAILS             (opcional)  override de correos por partner
//   PIPEDRIVE_ALLOWED_OWNERS   (opcional)  override de la lista de partners
//
// Manual: GET /api/weekly-email?key=<CRON_SECRET>&mode=all   (o mode=pending)
//         &dry=1   → NO envía ni reserva (solo muestra a quién iría + resumen).
//         &force=1 → reenvía aunque ya se haya enviado esta semana (ignora idempotencia).
// ============================================================

import nodemailer from "nodemailer";
import { partners, partnerEmails, weekStartStr, mondayStartMs, computeCompliance } from "./_week.js";
import { fetchPendingByPartner } from "./_pending.js";

const SUBJECT = "🚨 ACTUALIZA TU BASE 🚨";

const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// Sección "A continuación, lo que tienes por revisar" (bloques A/B/C).
// pending = { antiguos:[], cierre:[], incompletos:[] } o null (Pipedrive no disponible).
function pendingHtml(pending) {
  if (!pending) return "";
  const A = pending.antiguos || [], B = pending.cierre || [], C = pending.incompletos || [];
  const li = (inner) => `<li style="margin:7px 0;line-height:1.45">${inner}</li>`;
  const name = (d) => `<b>${esc(d.title)}</b>${d.org ? ` <span style="color:#6B6582">· ${esc(d.org)}</span>` : ""}`;
  const empty = (t) => `<div style="color:#6B6582;font-size:13px;margin:2px 0 0">${t}</div>`;

  let h = `<hr style="border:none;border-top:1px solid #E9E6F2;margin:26px 0 18px"/>
    <div style="font-size:16px;font-weight:800;color:#1D0446;margin:0 0 6px">A continuación, lo que tienes por revisar:</div>`;

  // Bloque A — negocios antiguos
  h += `<div style="font-size:14px;font-weight:700;margin:18px 0 6px">¿Se debe hacer algo con alguno de estos negocios?</div>`;
  h += A.length
    ? `<ul style="padding-left:18px;margin:0">` + A.map((d) => li(
        `${name(d)} <span style="color:#6B6582">(${esc(d.stageLabel)}, ${d.ageDays} días)</span><br/>` +
        `<span style="color:#B23A57">👀 Ojo a este negocio que no lo has tocado hace un tiempo</span>`)).join("") + `</ul>`
    : empty("Sin negocios antiguos pendientes ✅");

  // Bloque B — Follow-up y cierre
  h += `<div style="font-size:14px;font-weight:700;margin:20px 0 6px">¿Hay algún comentario que puedas agregar en "comentarios" que actualice la información de estos negocios?</div>`;
  h += B.length
    ? `<ul style="padding-left:18px;margin:0">` + B.map((d) => li(name(d))).join("") + `</ul>`
    : empty("Sin negocios en Follow-up y cierre ✅");

  // Bloque C — campos incompletos
  h += `<div style="font-size:14px;font-weight:700;margin:20px 0 6px">Estos negocios tienen campos por completar:</div>`;
  h += C.length
    ? `<ul style="padding-left:18px;margin:0">` + C.map((d) => li(
        `${name(d)} <span style="color:#6B6582">(${esc(d.stageLabel)})</span><br/>` +
        `<span style="color:#B23A57">Faltan: ${d.missing.map(esc).join(", ")}</span>`)).join("") + `</ul>`
    : empty("Sin negocios con campos incompletos ✅");

  return h;
}

function emailHtml(partnerName, pending) {
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1D0446">
    <div style="background:#FA5478;color:#fff;border-radius:14px;padding:18px 20px;text-align:center">
      <div style="font-size:22px;font-weight:800;letter-spacing:.5px">🚨 ACTUALIZA TU BASE 🚨</div>
    </div>
    <p style="font-size:16px;line-height:1.5;margin:22px 0 8px">Hola ${esc(partnerName)} 👋</p>
    <p style="font-size:16px;line-height:1.5;margin:0 0 16px">
      Es momento de <b>actualizar tu base de Pipedrive</b>, porque si no
      <b>el reporte de la semana estará desactualizado</b>. 📉
    </p>
    <p style="font-size:15px;line-height:1.5;margin:0 0 20px">
      Entra a la app, revisa tus negocios y, cuando termines, pulsa
      <b>"Terminé de revisar"</b> para dejar constancia. ✅
    </p>
    ${pendingHtml(pending)}
    <p style="font-size:13px;color:#6B6582;margin:26px 0 0">— mambo · pipeline</p>
  </div>`;
}

// Transporter SMTP con POOL (reutiliza una conexión → rápido, evita timeouts).
function makeTransport(user, appPassword) {
  const port = Number(process.env.SMTP_PORT || 465);
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port,
    secure: port === 465, // 465 → SSL; 587 → STARTTLS
    pool: true, maxConnections: 1, maxMessages: 50,
    auth: { user, pass: String(appPassword || "").replace(/\s+/g, "") },
  });
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
  const force = req.query && req.query.force === "1";

  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  if (!dry && (!gmailUser || !gmailPass)) {
    res.status(500).json({ ok: false, error: "Faltan GMAIL_USER / GMAIL_APP_PASSWORD." });
    return;
  }
  const from = `"Mambo Pipeline" <${gmailUser}>`;

  const list = partners();
  const emails = partnerEmails();
  const weekStart = weekStartStr();

  // Supabase: requerido para idempotencia (envío real) y para compliance (mode=pending).
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const needSupabase = !dry || mode === "pending";
  if (needSupabase && (!sbUrl || !sbKey)) {
    res.status(500).json({ ok: false, error: "Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY." });
    return;
  }
  const sbHeaders = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, "Content-Type": "application/json" };

  // Reserva idempotente: devuelve true si reservó (debe enviar), false si ya existía.
  async function reserve(p) {
    const r = await fetch(`${sbUrl}/rest/v1/weekly_email_sent?on_conflict=partner,week_start,mode`, {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify({ partner: p, week_start: weekStart, mode }),
    });
    if (!r.ok) throw new Error(`reserva HTTP ${r.status}`);
    const rows = await r.json().catch(() => []);
    return Array.isArray(rows) && rows.length > 0;
  }
  async function unreserve(p) {
    try {
      await fetch(`${sbUrl}/rest/v1/weekly_email_sent?partner=eq.${encodeURIComponent(p)}&week_start=eq.${weekStart}&mode=eq.${mode}`,
        { method: "DELETE", headers: sbHeaders });
    } catch (_) { /* best-effort */ }
  }

  try {
    // 1) A quién enviar
    let recipients = list.slice();
    if (mode === "pending") {
      const mondayIso = new Date(mondayStartMs()).toISOString();
      const [aRes, wRes] = await Promise.all([
        fetch(`${sbUrl}/rest/v1/activity_log?created_at=gte.${encodeURIComponent(mondayIso)}&select=actor,actor_email&limit=5000`, { headers: sbHeaders }),
        fetch(`${sbUrl}/rest/v1/weekly_review?week_start=eq.${weekStart}&select=partner,confirmed`, { headers: sbHeaders }),
      ]);
      if (!aRes.ok) throw new Error(`Supabase activity_log → HTTP ${aRes.status}`);
      if (!wRes.ok) throw new Error(`Supabase weekly_review → HTTP ${wRes.status}`);
      const compliance = computeCompliance(list, await aRes.json(), await wRes.json(), emails);
      recipients = compliance.filter((c) => !c.ok).map((c) => c.partner);
    }
    recipients = [...new Set(recipients)]; // dedup defensivo

    // 2) Pendientes por partner desde Pipedrive (una sola consulta; best-effort).
    let pendingByPartner = {};
    let pendingWarning = null;
    const pd = await fetchPendingByPartner(list);
    if (pd.ok) pendingByPartner = pd.byPartner;
    else { pendingWarning = pd.error; console.warn("[weekly-email] pendientes no disponibles:", pd.error); }

    // 3) Enviar (o simular), con idempotencia.
    const transporter = dry ? null : makeTransport(gmailUser, gmailPass);
    const sent = [], failed = [], skipped = [];
    try {
      for (const p of recipients) {
        const to = emails[p];
        if (!to) { skipped.push({ partner: p, reason: "sin correo" }); continue; }
        if (dry) { sent.push({ partner: p, to, dry: true }); continue; }

        // Idempotencia: reservar antes de enviar (force libera y reserva de nuevo).
        if (force) await unreserve(p);
        let reserved;
        try { reserved = await reserve(p); }
        catch (e) { failed.push({ partner: p, to, error: "reserva: " + (e.message || e) }); continue; }
        if (!reserved) { skipped.push({ partner: p, reason: "ya enviado esta semana (idempotencia)" }); continue; }

        try {
          await transporter.sendMail({ from, to, subject: SUBJECT, html: emailHtml(p, pendingByPartner[p]) });
          sent.push({ partner: p, to });
        } catch (e) {
          await unreserve(p); // liberar para poder reintentar
          failed.push({ partner: p, to, error: String(e && e.message ? e.message : e) });
        }
      }
    } finally {
      if (transporter) try { transporter.close(); } catch (_) {}
    }

    // Desglose de pendientes por destinatario (para verificar con dry=1).
    const pendientes = {};
    recipients.forEach((p) => {
      const b = pendingByPartner[p] || { antiguos: [], cierre: [], incompletos: [] };
      pendientes[p] = dry
        ? b // en dry, el detalle completo para revisar los bloques A/B/C
        : { antiguos: b.antiguos.length, cierre: b.cierre.length, incompletos: b.incompletos.length };
    });

    const summary = {
      ok: failed.length === 0,
      mode, semana: weekStart, dry: !!dry, force: !!force,
      destinatarios: recipients,
      enviados: sent.length, fallidos: failed.length, omitidos: skipped.length,
      resumen_pipedrive: pd.ok ? "incluido" : ("omitido (" + pendingWarning + ")"),
      pendientes,
      detalle: { sent, failed, skipped },
    };
    console.log("[weekly-email]", JSON.stringify({ ...summary, detalle: undefined, pendientes: undefined }));
    res.status(summary.ok ? 200 : 502).json(summary);
  } catch (e) {
    const fail = { ok: false, error: String(e && e.message ? e.message : e) };
    console.error("[weekly-email] ERROR", JSON.stringify(fail));
    res.status(502).json(fail);
  }
}

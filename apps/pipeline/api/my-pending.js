// ============================================================
// mambo · Pipeline — "MIS PENDIENTES" (por partner logueado)
//
// GET  → lista los pendientes del partner autenticado (bloques A/B/C), calculados
//        en vivo desde Pipedrive (pipeline 1, solo sus negocios), quitando de A/B
//        los ya "resueltos" esta semana (tabla pending_resolved).
// POST → ejecuta una acción sobre un negocio:
//        { dealId, action:"check" }                     → marca revisado (resuelto semana)
//        { dealId, action:"note",  comment }            → nota en Pipedrive + resuelto
//        { dealId, action:"field", fields:{...} }       → completa campos → escribe a Pipedrive
//        Todas registran en activity_log (cuenta como cumplimiento del partner).
//
// Requiere sesión de Supabase (Authorization: Bearer <access_token>). El correo
// autenticado se mapea a un partner; solo partners tienen pendientes.
//
// La escritura real a Pipedrive respeta el mismo interruptor que pipedrive-sync
// (PIPEDRIVE_TEST_DEAL_IDS / PIPEDRIVE_SYNC_ENABLED). El registro en Supabase
// (resuelto/actividad) ocurre siempre.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PIPEDRIVE_API_TOKEN,
//      PIPEDRIVE_COMPANY_DOMAIN (opc), PIPEDRIVE_SYNC_ENABLED / PIPEDRIVE_TEST_DEAL_IDS,
//      + las de _auth.js.
// ============================================================

import { verifyUser } from "./_auth.js";
import { partnerForEmail, weekStartStr } from "./_week.js";
import { fetchPendingByPartner } from "./_pending.js";
import { pdEnv, makePd, discoverFields, labelToId } from "./_pd.js";

const ALLOWED_PIPELINE = 1;

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body) { try { return JSON.parse(req.body); } catch (_) { return {}; } }
  const raw = await new Promise((resolve) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => resolve(d)); req.on("error", () => resolve("")); });
  try { return raw ? JSON.parse(raw) : {}; } catch (_) { return {}; }
}

const orgIdOf = (d) => {
  const o = d.org_id;
  if (o && typeof o === "object") return o.value != null ? o.value : o.id;
  return o != null ? o : null;
};

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const auth = await verifyUser(req);
  if (!auth.ok) { res.status(auth.status).json({ ok: false, error: auth.error }); return; }
  const email = auth.user.email;
  const partner = partnerForEmail(email);

  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) { res.status(500).json({ ok: false, error: "Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY." }); return; }
  const sbHeaders = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, "Content-Type": "application/json" };
  const week = weekStartStr();

  const sb = {
    get: async (path) => { const r = await fetch(`${sbUrl}/rest/v1/${path}`, { headers: sbHeaders }); if (!r.ok) throw new Error(`Supabase GET ${path} → HTTP ${r.status}`); return r.json(); },
    insert: async (table, row, prefer) => { await fetch(`${sbUrl}/rest/v1/${table}`, { method: "POST", headers: { ...sbHeaders, Prefer: prefer || "return=minimal" }, body: JSON.stringify(row) }); },
  };
  const logActivity = async (field, newValue, deal) => {
    try {
      await sb.insert("activity_log", [{
        actor: partner || email, actor_email: email,
        pipedrive_id: deal ? Number(deal.id) : null,
        org: (deal && (deal.org_name || (deal.org_id && deal.org_id.name))) || "",
        title: (deal && deal.title) || "", field, new_value: String(newValue || "").slice(0, 200),
      }]);
    } catch (e) { console.warn("[my-pending] activity_log:", e.message || e); }
  };
  const markResolved = async (dealId) => {
    await sb.insert("pending_resolved?on_conflict=partner,deal_id,week_start",
      [{ partner, deal_id: dealId, week_start: week }], "resolution=ignore-duplicates,return=minimal");
  };

  // ---------- GET: listar pendientes ----------
  if (req.method === "GET") {
    if (!partner) { res.status(200).json({ ok: true, partner: null, week, blocks: { A: [], B: [], C: [] }, note: "Tu correo no está asignado a un partner." }); return; }
    try {
      const pending = await fetchPendingByPartner([partner]);
      if (!pending.ok) throw new Error(pending.error || "No se pudo consultar Pipedrive.");
      const b = pending.byPartner[partner] || { antiguos: [], cierre: [], incompletos: [] };

      const resolvedRows = await sb.get(`pending_resolved?partner=eq.${encodeURIComponent(partner)}&week_start=eq.${week}&select=deal_id`);
      const resolved = new Set((resolvedRows || []).map((r) => Number(r.deal_id)));

      res.status(200).json({
        ok: true, partner, week,
        blocks: {
          A: b.antiguos.filter((d) => !resolved.has(Number(d.id))),
          B: b.cierre.filter((d) => !resolved.has(Number(d.id))),
          C: b.incompletos,
        },
      });
    } catch (e) {
      res.status(502).json({ ok: false, error: String(e && e.message ? e.message : e) });
    }
    return;
  }

  // ---------- POST: acción ----------
  if (req.method !== "POST") { res.status(405).json({ ok: false, error: "Usa GET o POST." }); return; }
  if (!partner) { res.status(403).json({ ok: false, error: "Tu correo no está asignado a un partner." }); return; }

  const body = await readBody(req);
  const dealId = parseInt(body.dealId, 10);
  const action = String(body.action || "");
  if (!Number.isFinite(dealId)) { res.status(400).json({ ok: false, error: "Falta dealId numérico." }); return; }
  if (!["check", "note", "field", "resolve"].includes(action)) { res.status(400).json({ ok: false, error: "Acción desconocida." }); return; }

  // ---- resolve: solo marcar resuelto (lo usa "Guardar" del panel de edición, que
  //      ya sincronizó y registró actividad por su cuenta). No toca Pipedrive. ----
  if (action === "resolve") {
    try { await markResolved(dealId); res.status(200).json({ ok: true, action, dealId, resolved: true }); }
    catch (e) { res.status(502).json({ ok: false, error: String(e && e.message ? e.message : e) }); }
    return;
  }

  const { token, base } = pdEnv();
  if (!token) { res.status(500).json({ ok: false, error: "Falta PIPEDRIVE_API_TOKEN." }); return; }
  const pd = makePd(token, base);

  // Interruptor de escritura (igual que pipedrive-sync).
  const testIds = (process.env.PIPEDRIVE_TEST_DEAL_IDS || "").split(",").map((x) => parseInt(x.trim(), 10)).filter(Number.isFinite);
  const enabled = process.env.PIPEDRIVE_SYNC_ENABLED === "true";
  const willWrite = testIds.length ? testIds.includes(dealId) : enabled;

  try {
    // Validar deal + pipeline 1
    const dj = await pd.get(`/deals/${dealId}`);
    const deal = dj.data;
    if (!deal) { res.status(404).json({ ok: false, error: `No se encontró el negocio ${dealId}.` }); return; }
    if (Number(deal.pipeline_id) !== ALLOWED_PIPELINE) { res.status(409).json({ ok: false, error: `El negocio ${dealId} no está en el pipeline ${ALLOWED_PIPELINE}.` }); return; }

    // ---- check: marcar revisado ----
    if (action === "check") {
      await markResolved(dealId);
      await logActivity("Revisado (Mis pendientes)", "Marcado como revisado", deal);
      res.status(200).json({ ok: true, action, dealId, resolved: true });
      return;
    }

    // ---- note: comentario como nota + resuelto ----
    if (action === "note") {
      const comment = String(body.comment || "").trim();
      if (!comment) { res.status(400).json({ ok: false, error: "El comentario está vacío." }); return; }
      let noteCreated = false, noteError = null;
      if (willWrite) {
        try { await pd.post("/notes", { deal_id: dealId, content: comment }); noteCreated = true; }
        catch (e) { noteError = e.message || String(e); }
      }
      await markResolved(dealId);
      await logActivity("Comentario", comment, deal);
      res.status(200).json({ ok: true, action, dealId, resolved: true, simulated: !willWrite, noteCreated, noteError: noteError || undefined });
      return;
    }

    // ---- field: completar campos → Pipedrive ----
    const f = body.fields || {};
    const { keys, opts, industryKey, industryOpts } = await discoverFields(pd);
    const dealBody = {};
    const applied = [];
    const warnings = [];

    // Campos de lista (negocio): texto → id de opción
    const listCols = [
      ["client_type", "Tipo de cliente"], ["country", "País"], ["vertical", "Vertical"],
      ["sale_type", "Tipo de Venta"], ["source", "Fuente lead"],
    ];
    for (const [col, label] of listCols) {
      const val = (f[col] || "").toString().trim();
      if (!val) continue;
      if (!keys[col]) { warnings.push(`"${label}" no existe en Pipedrive por nombre.`); continue; }
      const id = labelToId(opts[col], val);
      if (id == null) { warnings.push(`Opción "${val}" no existe para "${label}".`); continue; }
      dealBody[keys[col]] = id; applied.push({ field: label, value: val });
    }
    // Nativos
    if (f.prob !== undefined && f.prob !== null && f.prob !== "") { dealBody.probability = Number(f.prob); applied.push({ field: "Probabilidad", value: `${Number(f.prob)}%` }); }
    if (f.value !== undefined && f.value !== null && f.value !== "") { dealBody.value = Number(f.value) || 0; applied.push({ field: "Valor (monto)", value: String(Number(f.value) || 0) }); }
    if (f.closeDate) { dealBody.expected_close_date = String(f.closeDate); applied.push({ field: "Fecha de cierre prevista", value: String(f.closeDate) }); }

    // Persona de contacto → crear y vincular
    const contact = f.contact && (f.contact.name || "").toString().trim() ? f.contact : null;

    // Industria → en la ORGANIZACIÓN
    const industriaText = (f.industria || "").toString().trim();

    if (!willWrite) {
      // Simular: no se escribe en Pipedrive, pero sí se registra la actividad.
      for (const a of applied) await logActivity(a.field, a.value, deal);
      if (contact) await logActivity("Persona de contacto", contact.name, deal);
      if (industriaText) await logActivity("Industria", industriaText, deal);
      res.status(200).json({ ok: true, action, dealId, simulated: true, wouldApply: applied, contact: !!contact, industria: industriaText || undefined, warnings });
      return;
    }

    // Persona
    if (contact) {
      const personBody = { name: contact.name.toString().trim(), org_id: orgIdOf(deal) };
      if ((contact.email || "").toString().trim()) personBody.email = [{ value: contact.email.toString().trim(), primary: true, label: "work" }];
      if ((contact.phone || "").toString().trim()) personBody.phone = [{ value: contact.phone.toString().trim(), primary: true, label: "work" }];
      const person = await pd.post("/persons", personBody);
      dealBody.person_id = person.id;
      applied.push({ field: "Persona de contacto", value: contact.name });
    }

    // Industria (org)
    if (industriaText) {
      if (!industryKey) warnings.push('El campo "Industria" no existe en la organización por nombre.');
      else {
        const oid = orgIdOf(deal);
        const id = labelToId(industryOpts, industriaText);
        if (!oid) warnings.push("El negocio no tiene organización para escribir la Industria.");
        else if (id == null) warnings.push(`Opción de Industria "${industriaText}" no existe.`);
        else { await pd.put(`/organizations/${oid}`, { [industryKey]: id }); applied.push({ field: "Industria", value: industriaText }); }
      }
    }

    // Escribir los campos del negocio (si hay)
    if (Object.keys(dealBody).length) await pd.put(`/deals/${dealId}`, dealBody);

    // Registrar actividad de lo aplicado
    for (const a of applied) await logActivity(a.field, a.value, deal);

    res.status(200).json({ ok: true, action, dealId, simulated: false, applied, warnings });
  } catch (e) {
    console.error("[my-pending] ERROR", String(e && e.message ? e.message : e));
    res.status(502).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
}

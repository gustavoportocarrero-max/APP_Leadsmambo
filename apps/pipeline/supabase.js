/* ============================================================
   mambo · Pipeline — capa de datos Supabase
   Fuente de verdad compartida. Sin login (clave anónima + RLS permisivo).

   Config: se obtiene en runtime, sin hardcodear claves:
     1) window.__SUPABASE_CONFIG__  (opcional, para desarrollo local)
     2) GET /api/config             (serverless en Vercel, lee env vars)
   Si no hay config o falla, la app entra en "modo demo" (datos locales).

   Mapeo de columnas: la tabla usa snake_case (client_type, loss_reason,
   close_date, updated_at); el modelo de la app usa camelCase.
   ============================================================ */
window.SupaDeals = (function () {
  "use strict";

  let client = null;
  let ready = false;
  let allowedDomain = "";

  async function getConfig() {
    if (window.__SUPABASE_CONFIG__ && window.__SUPABASE_CONFIG__.url) {
      return window.__SUPABASE_CONFIG__;
    }
    try {
      const r = await fetch("/api/config", { cache: "no-store" });
      if (r.ok) {
        const c = await r.json();
        if (c && c.url && c.anonKey) return c;
      }
    } catch (_) { /* sin endpoint (p.ej. local) → modo demo */ }
    return null;
  }

  function rowToDeal(r) {
    return {
      id: r.id,
      pipedriveId: (r.pipedrive_id === null || r.pipedrive_id === undefined) ? null : r.pipedrive_id,
      org: r.org || "",
      title: r.title || "",
      owner: r.owner || "",
      stage: r.stage || "target",
      amount: Number(r.amount) || 0,
      prob: (r.prob === null || r.prob === undefined || r.prob === "") ? null : Number(r.prob),
      vertical: r.vertical || "",
      clientType: r.client_type || "",
      industry: r.industry || "",
      source: r.source || "",
      saleType: r.sale_type || "",
      closeDate: r.close_date || "",
      comment: r.comment || "",
      status: r.status || "activo",
      lossReason: r.loss_reason || "",
    };
  }

  // Solo los campos editables se escriben de vuelta (updated_at lo pone el trigger).
  function editablePatch(d) {
    return {
      stage: d.stage,
      amount: d.amount,
      prob: d.prob,
      comment: d.comment,
      status: d.status,
      loss_reason: d.lossReason || "",
      close_date: d.closeDate ? d.closeDate : null, // "" → null (columna date)
    };
  }

  async function init() {
    const cfg = await getConfig();
    if (!cfg || !window.supabase) return false;
    client = window.supabase.createClient(cfg.url, cfg.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      realtime: { params: { eventsPerSecond: 5 } },
    });
    allowedDomain = cfg.allowedDomain || "";
    ready = true;
    return true;
  }

  /* ---------- Auth (login con Google) ---------- */
  async function getUser() {
    if (!client) return null;
    const { data } = await client.auth.getSession();
    return (data && data.session && data.session.user) ? data.session.user : null;
  }
  async function signInWithGoogle(redirectTo, hostedDomain) {
    if (!client) throw new Error("Supabase no inicializado");
    const options = { redirectTo };
    if (hostedDomain) options.queryParams = { hd: hostedDomain }; // sugiere el dominio a Google (no es garantía)
    return client.auth.signInWithOAuth({ provider: "google", options });
  }
  async function signOut() {
    if (client) await client.auth.signOut();
  }
  // cb(user|null) en cada cambio de sesión (incluye la sesión inicial)
  function onAuth(cb) {
    if (!client) return;
    client.auth.onAuthStateChange((_event, session) => {
      cb(session && session.user ? session.user : null);
    });
  }

  async function fetchAll() {
    const { data, error } = await client
      .from("deals")
      .select("*")
      .order("org", { ascending: true })
      .order("title", { ascending: true });
    if (error) throw error;
    return data.map(rowToDeal);
  }

  // syncPending: marca la fila como "cambio local sin confirmar en Pipedrive"
  // para que el cron de entrada NO la sobreescriba con datos viejos.
  async function updateDeal(id, deal, syncPending) {
    const patch = editablePatch(deal);
    patch.sync_pending = !!syncPending;
    const { data, error } = await client
      .from("deals")
      .update(patch)
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    return rowToDeal(data);
  }

  // Borra el negocio (se usa al cerrarlo: ganado/perdido → sale de la vista activa).
  async function deleteDeal(id) {
    const { error } = await client.from("deals").delete().eq("id", id);
    if (error) throw error;
  }

  // Registra actividad (una fila por campo cambiado). Best-effort: si falla, no
  // debe romper el guardado (lo maneja quien llama con try/catch).
  async function logActivity(rows) {
    if (!client || !rows || !rows.length) return;
    const { error } = await client.from("activity_log").insert(rows);
    if (error) throw error;
  }

  // onChange(eventType, deal|null, oldId|null)
  function subscribe(onChange) {
    if (!client) return null;
    const ch = client
      .channel("deals-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "deals" },
        (payload) => {
          const deal = payload.new && payload.new.id ? rowToDeal(payload.new) : null;
          const oldId = payload.old ? payload.old.id : null;
          onChange(payload.eventType, deal, oldId);
        }
      )
      .subscribe();
    return ch;
  }

  return {
    init,
    fetchAll,
    updateDeal,
    deleteDeal,
    logActivity,
    subscribe,
    rowToDeal,
    editablePatch,
    getUser,
    signInWithGoogle,
    signOut,
    onAuth,
    get allowedDomain() { return allowedDomain; },
    get ready() { return ready; },
  };
})();

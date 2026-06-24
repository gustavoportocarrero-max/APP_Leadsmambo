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
    };
  }

  async function init() {
    const cfg = await getConfig();
    if (!cfg || !window.supabase) return false;
    client = window.supabase.createClient(cfg.url, cfg.anonKey, {
      realtime: { params: { eventsPerSecond: 5 } },
    });
    ready = true;
    return true;
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

  async function updateDeal(id, deal) {
    const { data, error } = await client
      .from("deals")
      .update(editablePatch(deal))
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    return rowToDeal(data);
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
    subscribe,
    rowToDeal,
    editablePatch,
    get ready() { return ready; },
  };
})();

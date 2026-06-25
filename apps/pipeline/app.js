/* ============================================================
   mambo · App de Pipeline — lógica
   Fuente de verdad: Supabase (compartida, tiempo real).
   Sin login: identidad de partner en localStorage; cada quien edita
   solo SUS negocios (barrera de UI). Si Supabase no está configurado,
   corre en "modo demo" con los datos locales (data.js).
   ============================================================ */
(function () {
  "use strict";

  const STORAGE_USER = "mambo.pipeline.user";
  const STORAGE_PENDING = "mambo.pipeline.pending";
  const STORAGE_PENDING_META = "mambo.pipeline.pendingmeta"; // qué quedó sin confirmar por negocio
  const STORAGE_DEMO = "mambo.pipeline.demo"; // overrides locales cuando no hay Supabase
  const stageById = Object.fromEntries(STAGES.map((s) => [s.id, s]));

  /* ---------- estado ---------- */
  let deals = [];
  let filters = { owner: "", stage: "", text: "", showLost: false };
  let editingId = null;     // id del negocio abierto en detalle
  let draft = null;         // copia de trabajo del negocio en edición
  let draftEditable = false;// si el usuario actual puede editar el draft
  let mode = "demo";        // "supabase" | "demo"
  let currentUser = localStorage.getItem(STORAGE_USER) || "";
  // pendingIds = negocios con cambios PENDIENTES de confirmar en Pipedrive.
  // Un guardado confirmado en Pipedrive saca al negocio de aquí (queda en 0);
  // cualquier guardado no confirmado (sin pipedrive_id, monto bloqueado por
  // productos, error de red, modo prueba/dry-run) lo mantiene pendiente.
  let pendingIds = new Set(loadPending());
  let pendingMeta = loadPendingMeta();     // { [id]: { changes, note } } = lo que falta confirmar
  const retrying = new Set();              // ids con un reintento en curso (evita doble click)
  let lastWrite = { id: null, t: 0 };      // para no auto-notificar mi propio cambio

  /* ---------- DOM refs ---------- */
  const $ = (id) => document.getElementById(id);
  const els = {
    list: $("dealList"),
    ownerFilter: $("ownerFilter"),
    stageChips: $("stageChips"),
    lostToggle: $("lostToggle"),
    search: $("search"),
    changeCount: $("changeCount"),
    statChanges: $("statChanges"),
    totalAmount: $("totalAmount"),
    connBanner: $("connBanner"),
    // identidad
    identityChip: $("identityChip"),
    identityAvatar: $("identityAvatar"),
    identityName: $("identityName"),
    identityOverlay: $("identityOverlay"),
    ownerList: $("ownerList"),
    // detalle
    detail: $("detail"),
    detailBody: $("detailBody"),
    readonlyNotice: $("readonlyNotice"),
    syncNotice: $("syncNotice"),
    dOrg: $("dOrg"),
    dTitle: $("dTitle"),
    dTags: $("dTags"),
    stageGrid: $("stageGrid"),
    amountInput: $("amountInput"),
    probInput: $("probInput"),
    probVal: $("probVal"),
    commentInput: $("commentInput"),
    resultSeg: $("resultSeg"),
    wonHint: $("wonHint"),
    lossReasons: $("lossReasons"),
    reasonChips: $("reasonChips"),
    lossError: $("lossError"),
    saveBtn: $("saveBtn"),
    cancelBtn: $("cancelBtn"),
    backBtn: $("backBtn"),
    toast: $("toast"),
  };

  /* ============================================================
     Persistencia local (solo identidad + lista de exportación)
     ============================================================ */
  function loadPending() {
    try { return JSON.parse(localStorage.getItem(STORAGE_PENDING) || "[]"); }
    catch (_) { return []; }
  }
  function savePending() {
    localStorage.setItem(STORAGE_PENDING, JSON.stringify([...pendingIds]));
  }
  function loadPendingMeta() {
    try { return JSON.parse(localStorage.getItem(STORAGE_PENDING_META) || "{}"); }
    catch (_) { return {}; }
  }
  function savePendingMeta() {
    localStorage.setItem(STORAGE_PENDING_META, JSON.stringify(pendingMeta));
  }

  // --- Modo demo: persistir ediciones locales (sin Supabase) ---
  function loadDemoOverrides() {
    try { return JSON.parse(localStorage.getItem(STORAGE_DEMO) || "{}"); }
    catch (_) { return {}; }
  }
  function saveDemoOverride(d) {
    const o = loadDemoOverrides();
    o[d.id] = {
      stage: d.stage, amount: d.amount, prob: d.prob,
      comment: d.comment, status: d.status, lossReason: d.lossReason,
    };
    localStorage.setItem(STORAGE_DEMO, JSON.stringify(o));
  }
  function seedDemoDeals() {
    const ov = loadDemoOverrides();
    return SEED_DEALS.map((d) => {
      const n = normalize(d);
      return ov[n.id] ? { ...n, ...ov[n.id] } : n;
    });
  }

  function normalize(d) {
    return {
      id: d.id,
      pipedriveId: (d.pipedriveId === null || d.pipedriveId === undefined) ? null : d.pipedriveId,
      org: d.org || "",
      title: d.title || "",
      owner: d.owner || "",
      stage: d.stage || "target",
      amount: Number(d.amount) || 0,
      prob: d.prob === null || d.prob === "" || d.prob === undefined ? null : Number(d.prob),
      vertical: d.vertical || "",
      clientType: d.clientType || "",
      industry: d.industry || "",
      source: d.source || "",
      closeDate: d.closeDate || "",
      comment: d.comment || "",
      status: d.status || "activo",
      lossReason: d.lossReason || "",
    };
  }

  function applyDeal(d) {
    const i = deals.findIndex((x) => x.id === d.id);
    if (i >= 0) deals[i] = d; else deals.push(d);
  }

  /* ============================================================
     Permisos de edición (por propietario)
     ============================================================ */
  function isEditable(d) {
    return !!currentUser && d.owner === currentUser;
  }

  /* ============================================================
     Pendientes de confirmar en Pipedrive
     ============================================================ */
  function isPending(d) { return pendingIds.has(d.id); }
  function pendingDeals() { return deals.filter((d) => pendingIds.has(d.id)); }

  /* ============================================================
     Helpers de formato
     ============================================================ */
  function fmtMoney(n) {
    if (!n) return "US$0";
    return "US$" + Number(n).toLocaleString("en-US");
  }
  function initials(name) {
    if (!name) return "··";
    return name.split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase();
  }
  function probText(p) { return p === null ? "—" : p + "%"; }

  /* ============================================================
     Identidad — selector "¿Quién eres?"
     ============================================================ */
  function ownersList() {
    const base = (typeof OWNERS !== "undefined") ? OWNERS.slice() : [];
    const extra = [...new Set(deals.map((d) => d.owner))].filter((o) => o && !base.includes(o));
    return base.concat(extra.sort());
  }

  function renderOwnerChoices() {
    els.ownerList.innerHTML = ownersList().map((o) =>
      `<button class="id-owner" data-owner="${escapeAttr(o)}">
        <span class="id-owner-av">${initials(o)}</span>
        <span>${escapeHtml(o)}</span>
      </button>`
    ).join("");
  }

  function showIdentity() {
    renderOwnerChoices();
    els.identityOverlay.classList.add("open");
    els.identityOverlay.setAttribute("aria-hidden", "false");
  }
  function hideIdentity() {
    els.identityOverlay.classList.remove("open");
    els.identityOverlay.setAttribute("aria-hidden", "true");
  }
  function chooseUser(name) {
    currentUser = name;
    localStorage.setItem(STORAGE_USER, name);
    updateIdentityChip();
    hideIdentity();
    renderAll();
    toast("Editas como: " + name);
  }
  function updateIdentityChip() {
    els.identityAvatar.textContent = initials(currentUser);
    els.identityName.textContent = currentUser || "¿Quién eres?";
  }

  /* ============================================================
     Banner de conexión
     ============================================================ */
  function showBanner(msg) {
    els.connBanner.textContent = msg;
    els.connBanner.hidden = false;
  }
  function hideBanner() { els.connBanner.hidden = true; }

  /* ============================================================
     Render — header / stats
     ============================================================ */
  function renderStats() {
    // "Cambios" = negocios pendientes de confirmar en Pipedrive (0 = todo sincronizado)
    const n = pendingDeals().length;
    els.changeCount.textContent = n;
    els.statChanges.classList.toggle("changed", n > 0);

    // "En juego" = solo negocios en curso (excluye ganados y perdidos)
    const total = deals
      .filter((d) => d.status === "activo")
      .reduce((sum, d) => sum + (d.amount || 0), 0);
    els.totalAmount.textContent = fmtMoney(total);
  }

  /* ============================================================
     Render — filtros
     ============================================================ */
  function renderOwnerFilter() {
    const owners = [...new Set(deals.map((d) => d.owner))].filter(Boolean).sort();
    els.ownerFilter.innerHTML =
      '<option value="">Todos los dueños</option>' +
      owners.map((o) => `<option value="${escapeAttr(o)}">${escapeHtml(o)}</option>`).join("");
    els.ownerFilter.value = filters.owner;
  }

  function renderStageChips() {
    const all = `<button class="chip" data-stage="" aria-pressed="${filters.stage === "" ? "true" : "false"}">Todas</button>`;
    const chips = STAGES.map((s) =>
      `<button class="chip" data-stage="${s.id}" aria-pressed="${filters.stage === s.id ? "true" : "false"}">${escapeHtml(s.label)}</button>`
    ).join("");
    els.stageChips.innerHTML = all + chips;
  }

  /* ============================================================
     Render — lista de negocios
     ============================================================ */
  function applyFilters() {
    const q = filters.text.trim().toLowerCase();
    return deals.filter((d) => {
      if (!filters.showLost && d.status === "perdido") return false;
      if (filters.owner && d.owner !== filters.owner) return false;
      if (filters.stage && d.stage !== filters.stage) return false;
      if (q && !(d.org.toLowerCase().includes(q) || d.title.toLowerCase().includes(q))) return false;
      return true;
    });
  }

  function renderList() {
    const rows = applyFilters();
    if (!rows.length) {
      els.list.innerHTML = '<div class="empty">Sin negocios que coincidan con los filtros.</div>';
      return;
    }
    els.list.innerHTML = rows.map(cardHtml).join("");
  }

  function cardHtml(d) {
    const st = stageById[d.stage] || { label: d.stage, bg: "#DCD7FF", text: "#1D0446" };
    const pending = isPending(d);
    const lost = d.status === "perdido";
    const won = d.status === "ganado";
    const locked = !isEditable(d);
    const badge = lost
      ? `<span class="badge lost">Perdido</span>`
      : won
        ? `<span class="badge won">Ganado</span>`
        : `<span class="badge" style="background:${st.bg};color:${st.text}">${escapeHtml(st.label)}</span>`;
    const lock = locked
      ? `<span class="lock" title="Solo lectura — pertenece a ${escapeAttr(d.owner)}">🔒</span>`
      : "";
    const noPd = !d.pipedriveId
      ? `<span class="nopd" title="Sin ID de Pipedrive — no se sincroniza">⚠</span>`
      : "";
    const pendingTag = pending
      ? `<span class="pending-tag" title="Cambio pendiente de confirmar en Pipedrive">⏳ pendiente</span>`
      : "";
    // Botón de reintento SOLO en pendientes (los ya sincronizados no lo muestran).
    const isRetrying = retrying.has(d.id);
    const retryBtn = pending
      ? `<button class="retry-btn" data-retry="${d.id}"${isRetrying ? " disabled" : ""}>${isRetrying ? "Reintentando…" : "↻ Reintentar sincronización"}</button>`
      : "";

    return `
      <div class="deal-card${pending ? " is-pending" : ""}${lost ? " is-lost" : ""}${locked ? " is-locked" : ""}" role="button" tabindex="0" data-id="${d.id}">
        <div>
          <div class="deal-org">${escapeHtml(d.org)}</div>
          <div class="deal-title">${escapeHtml(d.title)}</div>
        </div>
        <div class="avatar" title="${escapeAttr(d.owner)}">${initials(d.owner)}</div>
        <div class="deal-meta">
          ${badge}
          <span class="deal-amount">${fmtMoney(d.amount)}</span>
          <span class="deal-prob">${probText(d.prob)}</span>
          ${pendingTag}
          ${noPd}
          ${lock}
        </div>
        ${retryBtn}
      </div>`;
  }

  /* ============================================================
     Detalle / edición
     ============================================================ */
  function openDetail(id) {
    const d = deals.find((x) => x.id === id);
    if (!d) return;
    editingId = id;
    draft = { ...d };
    draftEditable = isEditable(d);

    els.dOrg.textContent = d.org;
    els.dTitle.textContent = d.title;

    const tags = [
      ["Propietario", d.owner],
      ["Vertical", d.vertical],
      ["Cliente", d.clientType],
      ["Industria", d.industry],
      ["Origen", d.source],
    ].filter(([, v]) => v);
    els.dTags.innerHTML = tags
      .map(([k, v]) => `<span class="tag"><span class="k">${k}:</span> ${escapeHtml(v)}</span>`)
      .join("");

    els.stageGrid.innerHTML = STAGES.map((s) =>
      `<button class="stage-opt" data-stage="${s.id}"
        style="background:${s.bg};color:${s.text}"
        aria-pressed="${draft.stage === s.id ? "true" : "false"}">${escapeHtml(s.label)}</button>`
    ).join("");

    els.amountInput.value = draft.amount || 0;
    els.probInput.value = draft.prob === null ? 0 : draft.prob;
    updateProbLabel(draft.prob);
    els.commentInput.value = draft.comment || "";

    setReadonlyUI(!draftEditable, d.owner);
    setResultUI();
    renderReasonChips();
    els.lossError.classList.remove("show");

    // aviso si el negocio no tiene ID de Pipedrive (no se sincroniza)
    if (draftEditable && !draft.pipedriveId) {
      els.syncNotice.hidden = false;
      els.syncNotice.textContent = "Sin ID de Pipedrive: los cambios se guardan en la app, pero NO se envían a Pipedrive.";
    } else {
      els.syncNotice.hidden = true;
    }
    refreshSaveState();
    els.detail.classList.add("open");
    els.detail.setAttribute("aria-hidden", "false");
    els.detailBody.scrollTop = 0;
  }

  // Aplica el modo solo-lectura cuando el negocio no es del usuario actual.
  function setReadonlyUI(readonly, owner) {
    els.detail.classList.toggle("is-readonly", readonly);
    els.amountInput.disabled = readonly;
    els.probInput.disabled = readonly;
    els.commentInput.disabled = readonly;
    els.resultSeg.querySelectorAll(".seg").forEach((b) => { b.disabled = readonly; });
    if (readonly) {
      els.readonlyNotice.hidden = false;
      els.readonlyNotice.textContent = currentUser
        ? `Solo lectura — este negocio es de ${owner}. Solo editas los tuyos.`
        : "Solo lectura — elige quién eres para editar tus negocios.";
    } else {
      els.readonlyNotice.hidden = true;
    }
  }

  function closeDetail() {
    els.detail.classList.remove("open");
    els.detail.setAttribute("aria-hidden", "true");
    editingId = null;
    draft = null;
    draftEditable = false;
  }

  function updateProbLabel(p) {
    if (p === null) {
      els.probVal.textContent = "Sin definir";
      els.probVal.classList.add("null");
    } else {
      els.probVal.textContent = p + "%";
      els.probVal.classList.remove("null");
    }
  }

  // "Ganado" solo desde Presentación de propuesta en adelante.
  function wonAllowed(stageId) {
    return stageId === "propuesta" || stageId === "cierre";
  }

  function setResultUI() {
    els.resultSeg.querySelectorAll(".seg").forEach((b) =>
      b.setAttribute("aria-pressed", b.dataset.status === draft.status ? "true" : "false"));
    const wonBtn = els.resultSeg.querySelector('.seg[data-status="ganado"]');
    const allow = wonAllowed(draft.stage);
    if (wonBtn) wonBtn.disabled = !allow;
    els.wonHint.hidden = allow;
    els.lossReasons.classList.toggle("hidden", draft.status !== "perdido");
  }

  function renderReasonChips() {
    els.reasonChips.innerHTML = LOSS_REASONS.map((r) =>
      `<button class="reason-chip" data-reason="${escapeAttr(r)}"
        aria-pressed="${draft.lossReason === r ? "true" : "false"}">${escapeHtml(r)}</button>`
    ).join("");
  }

  // Reglas de guardado:
  //  - perdido exige motivo
  //  - ganado solo desde "Presentación de propuesta" en adelante
  function canSave() {
    if (!draft || !draftEditable) return false;
    if (draft.status === "perdido" && !draft.lossReason) return false;
    if (draft.status === "ganado" && !wonAllowed(draft.stage)) return false;
    return true;
  }
  function refreshSaveState() {
    els.saveBtn.disabled = !canSave();
  }

  // Campos editables que cambiaron respecto al estado actual (para escribir
  // SOLO lo que cambió, tanto en Pipedrive como en el resumen).
  function computeChanges(orig, d) {
    const c = {};
    if (d.stage !== orig.stage) c.stage = d.stage;
    if (d.amount !== orig.amount) c.amount = d.amount;
    if (d.prob !== orig.prob) c.prob = d.prob;
    if (d.status !== orig.status) {
      c.status = d.status;
      if (d.status === "perdido") c.lossReason = d.lossReason || "";
    } else if (d.status === "perdido" && d.lossReason !== orig.lossReason) {
      c.lossReason = d.lossReason || "";
    }
    return c;
  }

  // Escritura server-side a Pipedrive (el token vive en el servidor).
  // `note` (opcional) = texto del comentario nuevo → se crea como nota del negocio.
  async function pushToPipedrive(pipedriveId, changes, note) {
    const r = await fetch("/api/pipedrive-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pipedriveId, changes, note: note || undefined }),
    });
    let j = {};
    try { j = await r.json(); } catch (_) {}
    if (!r.ok || !j.ok) throw new Error(j.error || ("HTTP " + r.status));
    return j; // { ok, simulated, confirmed, applied, noteCreated }
  }

  // Intenta sincronizar un negocio. Devuelve un resultado interpretado y, si algo
  // queda sin confirmar, QUÉ falta reenviar (remaining) y su categoría.
  //   category: "ok" | "structural" (no sirve reintentar igual) | "transient" (sí)
  async function attemptSync(deal, changes, note) {
    const hasFields = Object.keys(changes || {}).length > 0;
    if (!hasFields && !note) return { confirmed: true, category: "ok", message: "" };

    if (!deal.pipedriveId) {
      return {
        confirmed: false, category: "structural",
        message: "el negocio no tiene pipedrive_id. Reintentar no servirá hasta asignarle uno.",
        remaining: { changes, note: note || null },
      };
    }
    let r;
    try {
      r = await pushToPipedrive(deal.pipedriveId, changes, note);
      console.log("[pipeline] respuesta de /api/pipedrive-sync:", r);
    } catch (e) {
      console.error("Pipedrive sync error:", e);
      return {
        confirmed: false, category: "transient",
        message: "no se pudo conectar con Pipedrive (red o no respondió). Es temporal: puedes reintentar. (" + e.message + ")",
        remaining: { changes, note: note || null },
      };
    }
    if (r.simulated) {
      return {
        confirmed: false, category: "structural",
        message: "modo prueba/dry-run: no se escribió en Pipedrive. Reintentar no servirá hasta activar la escritura real (PIPEDRIVE_TEST_DEAL_IDS / PIPEDRIVE_SYNC_ENABLED).",
        remaining: { changes, note: note || null },
      };
    }
    const fieldsOk = r.confirmed;
    const noteOk = note ? !!r.noteCreated : true;
    if (fieldsOk && noteOk) return { confirmed: true, category: "ok", message: "" };

    const remaining = { changes: fieldsOk ? {} : changes, note: noteOk ? null : note };
    if (!fieldsOk) {
      return {
        confirmed: false, category: "structural",
        message: "Pipedrive no aplicó el cambio (suele ser porque el negocio tiene PRODUCTOS y el monto queda bloqueado, o el negocio está cerrado). Reintentar tal cual no servirá hasta resolver la causa.",
        remaining,
      };
    }
    // campos OK pero la nota falló → suele ser temporal
    return {
      confirmed: false, category: "transient",
      message: "los campos se enviaron, pero la nota no se creó. Suele ser temporal: puedes reintentar.",
      remaining,
    };
  }

  // Qué reenviar para un negocio pendiente. Si no hay metadata (pendiente "viejo"),
  // se reenvía el estado actual de los campos editables (sin nota).
  function metaFor(deal) {
    const m = pendingMeta[deal.id];
    if (m && ((m.changes && Object.keys(m.changes).length) || m.note)) return m;
    const c = { stage: deal.stage, amount: deal.amount, prob: deal.prob, status: deal.status };
    if (deal.status === "perdido") c.lossReason = deal.lossReason || "";
    return { changes: c, note: null };
  }

  function markPending(id, remaining) {
    pendingIds.add(id);
    pendingMeta[id] = remaining || { changes: {}, note: null };
    savePending(); savePendingMeta();
  }
  function clearPendingFor(id) {
    pendingIds.delete(id);
    delete pendingMeta[id];
    savePending(); savePendingMeta();
  }

  async function saveDraft() {
    if (!draftEditable) return;
    if (!canSave()) { els.lossError.classList.add("show"); return; }
    if (draft.status !== "perdido") draft.lossReason = "";
    const id = editingId;
    const orig = deals.find((x) => x.id === id) || {};
    const changes = computeChanges(orig, draft);
    const commentChanged = draft.comment !== orig.comment;
    const noteText = (commentChanged && draft.comment && draft.comment.trim()) ? draft.comment.trim() : null;
    if (Object.keys(changes).length === 0 && !commentChanged) { closeDetail(); return; } // nada cambió
    console.log("[pipeline] guardar deal", id, "· pipedrive_id:", orig.pipedriveId || "(ninguno)", "· cambios:", changes, "· nota:", noteText ? "sí" : "no");

    // 1) Intentar sincronizar con Pipedrive.
    els.saveBtn.disabled = true;
    const res = await attemptSync(orig, changes, noteText);

    // 2) Guardar SIEMPRE en la app (Supabase o demo): el cambio queda registrado
    //    y, si no se confirmó, marcado como pendiente.
    try {
      if (mode === "supabase") {
        const updated = await SupaDeals.updateDeal(id, draft);
        applyDeal(updated);
        lastWrite = { id: id, t: Date.now() };
      } else {
        const idx = deals.findIndex((x) => x.id === id);
        if (idx >= 0) { deals[idx] = { ...deals[idx], ...draft }; saveDemoOverride(deals[idx]); }
      }
    } catch (e) {
      console.error("Error al guardar en la app:", e);
      toast("No se pudo guardar el cambio. Reintenta.");
      refreshSaveState();
      return;
    }

    // 3) Pendiente sí/no.
    if (res.confirmed) { clearPendingFor(id); }
    else { markPending(id, res.remaining); }

    closeDetail();
    renderAll();
    toast(res.confirmed ? "Guardado y sincronizado con Pipedrive ✓" : "Guardado · ⏳ pendiente (" + res.message + ")");
  }

  // Reintentar SOLO lo que quedó pendiente de un negocio.
  async function retryDeal(id) {
    if (retrying.has(id)) return;
    const deal = deals.find((x) => x.id === id);
    if (!deal || !isPending(deal)) return;
    const meta = metaFor(deal);

    retrying.add(id);
    renderList(); // el botón pasa a "Reintentando…" y se deshabilita
    const res = await attemptSync(deal, meta.changes || {}, meta.note);
    retrying.delete(id);

    if (res.confirmed) {
      clearPendingFor(id);
      renderAll();
      toast("Sincronizado con Pipedrive ✓");
    } else {
      markPending(id, res.remaining); // actualiza lo que aún falta
      renderList();
      const prefix = res.category === "structural"
        ? "No se sincronizó (reintentar no servirá aún): "
        : "Falló (temporal, puedes reintentar): ";
      toast(prefix + res.message);
    }
  }

  /* ============================================================
     Realtime — cambios de otros partners
     ============================================================ */
  function onRealtime(type, deal, oldId) {
    if (type === "DELETE") {
      deals = deals.filter((d) => d.id !== oldId);
      pendingIds.delete(oldId);
    } else if (deal) {
      applyDeal(deal);
    }
    renderAll();
    // refrescar el filtro de dueños por si entró un propietario nuevo
    renderOwnerFilter();
    const mine = deal && lastWrite.id === deal.id && (Date.now() - lastWrite.t < 2500);
    if (deal && !mine) toast("Pipeline actualizado");
  }

  /* ============================================================
     Toast / escape
     ============================================================ */
  let toastTimer = null;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2200);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  function renderAll() {
    renderStats();
    renderList();
  }

  /* ============================================================
     Eventos
     ============================================================ */
  function bindEvents() {
    els.list.addEventListener("click", (e) => {
      const retry = e.target.closest(".retry-btn");
      if (retry) { e.stopPropagation(); retryDeal(Number(retry.dataset.retry)); return; }
      const card = e.target.closest(".deal-card");
      if (card) openDetail(Number(card.dataset.id));
    });
    // accesibilidad: abrir con Enter/Espacio (la card es un div role=button)
    els.list.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (e.target.closest(".retry-btn")) return; // el botón maneja su propio Enter
      const card = e.target.closest(".deal-card");
      if (card) { e.preventDefault(); openDetail(Number(card.dataset.id)); }
    });

    els.search.addEventListener("input", (e) => { filters.text = e.target.value; renderList(); });
    els.ownerFilter.addEventListener("change", (e) => { filters.owner = e.target.value; renderList(); });
    els.stageChips.addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      filters.stage = chip.dataset.stage;
      renderStageChips();
      renderList();
    });
    els.lostToggle.addEventListener("click", () => {
      filters.showLost = !filters.showLost;
      els.lostToggle.setAttribute("aria-pressed", filters.showLost ? "true" : "false");
      els.lostToggle.textContent = filters.showLost ? "Ocultar perdidos" : "Ver perdidos";
      renderList();
    });

    // identidad
    els.identityChip.addEventListener("click", showIdentity);
    els.ownerList.addEventListener("click", (e) => {
      const b = e.target.closest(".id-owner");
      if (b) chooseUser(b.dataset.owner);
    });

    // detalle: etapa (solo si editable)
    els.stageGrid.addEventListener("click", (e) => {
      if (!draftEditable) return;
      const opt = e.target.closest(".stage-opt");
      if (!opt) return;
      draft.stage = opt.dataset.stage;
      els.stageGrid.querySelectorAll(".stage-opt").forEach((b) =>
        b.setAttribute("aria-pressed", b.dataset.stage === draft.stage ? "true" : "false"));
      // si "ganado" deja de ser válido para la nueva etapa, volver a "en curso"
      if (draft.status === "ganado" && !wonAllowed(draft.stage)) draft.status = "activo";
      setResultUI();
      refreshSaveState();
    });
    els.amountInput.addEventListener("input", (e) => {
      if (draftEditable) draft.amount = Number(e.target.value) || 0;
    });
    els.probInput.addEventListener("input", (e) => {
      if (!draftEditable) return;
      draft.prob = Number(e.target.value);
      updateProbLabel(draft.prob);
    });
    els.commentInput.addEventListener("input", (e) => {
      if (draftEditable) draft.comment = e.target.value;
    });

    els.resultSeg.addEventListener("click", (e) => {
      if (!draftEditable) return;
      const b = e.target.closest(".seg");
      if (!b || b.disabled) return;
      draft.status = b.dataset.status;
      if (draft.status !== "perdido") draft.lossReason = "";
      setResultUI();
      renderReasonChips();
      els.lossError.classList.toggle("show", draft.status === "perdido" && !draft.lossReason);
      refreshSaveState();
    });
    els.reasonChips.addEventListener("click", (e) => {
      if (!draftEditable) return;
      const chip = e.target.closest(".reason-chip");
      if (!chip) return;
      draft.lossReason = chip.dataset.reason;
      els.reasonChips.querySelectorAll(".reason-chip").forEach((c) =>
        c.setAttribute("aria-pressed", c.dataset.reason === draft.lossReason ? "true" : "false"));
      els.lossError.classList.remove("show");
      refreshSaveState();
    });

    els.saveBtn.addEventListener("click", saveDraft);
    els.cancelBtn.addEventListener("click", closeDetail);
    els.backBtn.addEventListener("click", closeDetail);

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (els.identityOverlay.classList.contains("open")) { if (currentUser) hideIdentity(); }
      else if (els.detail.classList.contains("open")) closeDetail();
    });
  }

  /* ============================================================
     Arranque
     ============================================================ */
  async function boot() {
    let connected = false;
    try { connected = await SupaDeals.init(); } catch (e) { console.error(e); }

    if (connected) {
      try {
        deals = await SupaDeals.fetchAll();
        mode = "supabase";
        SupaDeals.subscribe(onRealtime);
        hideBanner();
      } catch (e) {
        console.error("Error leyendo Supabase:", e);
        deals = seedDemoDeals();
        mode = "demo";
        showBanner("No se pudo leer Supabase. Mostrando datos locales (modo demo).");
      }
    } else {
      deals = seedDemoDeals();
      mode = "demo";
      showBanner("Modo demo (sin Supabase). Configura las variables de entorno para datos compartidos.");
    }

    // limpiar pendientes que ya no existen
    const validIds = new Set(deals.map((d) => d.id));
    [...pendingIds].forEach((id) => { if (!validIds.has(id)) pendingIds.delete(id); });
    Object.keys(pendingMeta).forEach((k) => { if (!validIds.has(Number(k))) delete pendingMeta[k]; });
    savePending(); savePendingMeta();

    renderOwnerFilter();
    renderAll();
  }

  async function init() {
    renderStageChips();
    bindEvents();
    updateIdentityChip();
    await boot();
    if (!currentUser) showIdentity();
  }

  document.addEventListener("DOMContentLoaded", init);
})();

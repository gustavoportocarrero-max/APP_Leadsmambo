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
  const STORAGE_DEMO_NEW = "mambo.pipeline.democreated"; // negocios creados en modo demo
  const STORAGE_META = "mambo.pipeline.meta"; // caché de catálogos de Pipedrive (opciones + orgs)
  const META_TTL_MS = 15 * 60 * 1000; // 15 min: caché fresca sin ser lenta
  const stageById = Object.fromEntries(STAGES.map((s) => [s.id, s]));
  // Etapas que cuentan para "EN JUEGO" (excluye Target y Nurturing a propósito).
  const IN_PLAY_STAGES = new Set(["contacto", "primera", "propuesta", "cierre"]);

  /* ---------- estado ---------- */
  let deals = [];
  let filters = { owner: "", stage: "", text: "", showLost: false };
  let editingId = null;     // id del negocio abierto en detalle
  let draft = null;         // copia de trabajo del negocio en edición
  let draftEditable = false;// si el usuario actual puede editar el draft
  let mode = "demo";        // "supabase" | "demo"
  let authRequired = false; // true cuando hay Supabase (login obligatorio)
  let currentEmail = "";    // correo de la sesión Google (identidad real)
  let isAdminUser = false;  // administrador: puede editar cualquier negocio
  let dataLoaded = false;   // datos ya cargados tras autenticar
  let authError = "";       // mensaje a mostrar en el login (p.ej. dominio no permitido)
  // En modo demo (sin Supabase) se conserva el selector manual "¿Quién eres?".
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
    accountOverlay: $("accountOverlay"),
    accEmail: $("accEmail"),
    accPartner: $("accPartner"),
    logoutBtn: $("logoutBtn"),
    accountCloseBtn: $("accountCloseBtn"),
    loginScreen: $("loginScreen"),
    googleBtn: $("googleBtn"),
    loginError: $("loginError"),
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
    closeMonth: $("closeMonth"),
    closeYear: $("closeYear"),
    closeCurrent: $("closeCurrent"),
    resultSeg: $("resultSeg"),
    wonHint: $("wonHint"),
    lossReasons: $("lossReasons"),
    reasonChips: $("reasonChips"),
    lossError: $("lossError"),
    saveBtn: $("saveBtn"),
    cancelBtn: $("cancelBtn"),
    backBtn: $("backBtn"),
    toast: $("toast"),
    // crear negocio
    fabWrap: $("fabWrap"),
    addDealBtn: $("addDealBtn"),
    createPanel: $("createPanel"),
    createBody: $("createBody"),
    createError: $("createError"),
    createSimNotice: $("createSimNotice"),
    cTitle: $("cTitle"),
    cOwnerField: $("cOwnerField"),
    cOwner: $("cOwner"),
    cOrgExisting: $("cOrgExisting"),
    cOrgSearch: $("cOrgSearch"),
    cOrgList: $("cOrgList"),
    cOrgNewWrap: $("cOrgNewWrap"),
    cOrgNewName: $("cOrgNewName"),
    cOrgSelected: $("cOrgSelected"),
    cOrgNewBtn: $("cOrgNewBtn"),
    cOrgExistingBtn: $("cOrgExistingBtn"),
    cStageGrid: $("cStageGrid"),
    cAmount: $("cAmount"),
    cProb: $("cProb"),
    cProbVal: $("cProbVal"),
    cCloseMonth: $("cCloseMonth"),
    cCloseYear: $("cCloseYear"),
    cVertical: $("cVertical"),
    cCountry: $("cCountry"),
    cSource: $("cSource"),
    cClientType: $("cClientType"),
    cSaleType: $("cSaleType"),
    cIndustry: $("cIndustry"),
    cIndustryHint: $("cIndustryHint"),
    cContactName: $("cContactName"),
    cContactPhone: $("cContactPhone"),
    cContactEmail: $("cContactEmail"),
    createBackBtn: $("createBackBtn"),
    createCancelBtn: $("createCancelBtn"),
    createSubmitBtn: $("createSubmitBtn"),
    // revisión semanal ("Terminé de revisar")
    reviewBar: $("reviewBar"),
    reviewDoneBtn: $("reviewDoneBtn"),
    reviewOverlay: $("reviewOverlay"),
    reviewYesBtn: $("reviewYesBtn"),
    reviewNoBtn: $("reviewNoBtn"),
    reviewWarnOverlay: $("reviewWarnOverlay"),
    reviewWarnOkBtn: $("reviewWarnOkBtn"),
  };

  const STORAGE_REVIEW = "mambo.pipeline.review"; // demo: estado de revisión por semana/partner

  /* ---------- estado de creación ---------- */
  let metaCache = null;                 // { fields, organizations, partners, fieldsFound }
  let createDraft = null;               // { stage, prob, closeDate }
  let createOrg = { mode: "existing", org: null }; // org elegida: {id?, name}
  let creating = false;                 // envío en curso (evita doble click)

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
    const base = SEED_DEALS.map((d) => {
      const n = normalize(d);
      return ov[n.id] ? { ...n, ...ov[n.id] } : n;
    });
    // negocios creados en modo demo (persisten localmente)
    return base.concat(loadDemoCreated().map(normalize));
  }
  function loadDemoCreated() {
    try { return JSON.parse(localStorage.getItem(STORAGE_DEMO_NEW) || "[]"); }
    catch (_) { return []; }
  }
  function saveDemoCreated(arr) {
    localStorage.setItem(STORAGE_DEMO_NEW, JSON.stringify(arr));
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
      saleType: d.saleType || "",
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
     Permisos de edición
     ============================================================ */
  // Cualquier partner con identidad válida del login edita CUALQUIER negocio
  // (hay negocios compartidos entre partners; ya no hay candado "solo lo mío").
  // El propietario del negocio NO cambia al editarlo — solo se permite tocarlo,
  // y activity_log registra quién lo hizo (el partner logueado real).
  // Sigue siendo solo lectura únicamente para correos @mambo.pe sin partner
  // mapeado y sin ser admin (currentUser === "" y no admin).
  function isEditable(d) {
    if (isAdminUser) return true; // admin edita cualquier negocio
    return !!currentUser;         // partner con identidad → edita cualquiera
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

  /* ---------- Fecha de cierre: solo mes/año ---------- */
  const MONTHS_ES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
    "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
  const pad2 = (n) => String(n).padStart(2, "0");
  // Años disponibles en el selector. Editar aquí para agregar/quitar años.
  const CLOSE_YEARS = [2026, 2027];
  // Último día del mes (month 1–12). Correcto para 30/31 y bisiestos.
  function lastDayOfMonth(year, month) { return new Date(year, month, 0).getDate(); }
  // "YYYY-MM-DD" → "Julio 2026" (día no se muestra); "" si vacío.
  function fmtMonthYear(dateStr) {
    if (!dateStr || !/^\d{4}-\d{2}/.test(dateStr)) return "";
    const [y, m] = dateStr.split("-");
    return (MONTHS_ES[Number(m) - 1] || m) + " " + y;
  }
  function populateCloseSelects() {
    els.closeMonth.innerHTML = '<option value="">— Mes —</option>' +
      MONTHS_ES.map((name, i) => `<option value="${i + 1}">${name}</option>`).join("");
    els.closeYear.innerHTML = '<option value="">— Año —</option>' +
      CLOSE_YEARS.map((y) => `<option value="${y}">${y}</option>`).join("");
  }
  function setCloseDateUI(dateStr) {
    els.closeCurrent.hidden = true;
    if (dateStr && /^\d{4}-\d{2}/.test(dateStr)) {
      const [y, m] = dateStr.split("-");
      if (CLOSE_YEARS.includes(Number(y))) {
        // Año dentro de la lista → se muestra en los desplegables normalmente.
        els.closeMonth.value = String(Number(m));
        els.closeYear.value = String(Number(y));
      } else {
        // Año fuera de la lista (p. ej. 2025/2028 traído de Pipedrive): los
        // desplegables quedan limpios (solo ofrecen 2026/2027) y mostramos la
        // fecha guardada como texto para no perderla ni romper nada.
        els.closeMonth.value = "";
        els.closeYear.value = "";
        els.closeCurrent.hidden = false;
        els.closeCurrent.textContent = "Fecha guardada: " + fmtMonthYear(dateStr) +
          " · elige mes y año para cambiarla";
      }
    } else {
      els.closeMonth.value = "";
      els.closeYear.value = "";
    }
  }
  // draft.closeDate = último día del mes elegido; "" si falta mes o año (sin fecha).
  function updateCloseDraft() {
    els.closeCurrent.hidden = true; // al interactuar, se oculta la nota de "fecha guardada"
    const m = els.closeMonth.value, y = els.closeYear.value;
    if (m && y) draft.closeDate = `${y}-${pad2(Number(m))}-${pad2(lastDayOfMonth(Number(y), Number(m)))}`;
    else draft.closeDate = "";
  }

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
    els.identityAvatar.textContent = isAdminUser ? "★" : initials(currentUser || currentEmail);
    els.identityName.textContent = isAdminUser
      ? "Admin"
      : (currentUser || (authRequired ? (currentEmail || "Cuenta") : "¿Quién eres?"));
    updateFabVisibility();
  }

  /* ============================================================
     Crear negocio — visibilidad del botón (+)
     ============================================================ */
  // Puede crear: admin (elige propietario) o partner con identidad. Un correo de
  // Mambo sin partner asignado es solo lectura → no crea. En demo, tras elegir quién.
  function canCreate() {
    if (isAdminUser) return true;
    return !!currentUser;
  }
  function updateFabVisibility() {
    if (!els.fabWrap) return;
    els.fabWrap.hidden = !canCreate();
    // "Terminé de revisar": solo para partners (identidad de partner del login);
    // el admin (currentUser vacío) y los correos sin mapear no lo ven.
    if (els.reviewBar) els.reviewBar.hidden = !currentUser;
  }

  /* ============================================================
     Login con Google (Supabase Auth) + cuenta
     ============================================================ */
  function showLogin(errorMsg) {
    els.loginScreen.hidden = false;
    if (errorMsg) { els.loginError.hidden = false; els.loginError.textContent = errorMsg; }
    else { els.loginError.hidden = true; els.loginError.textContent = ""; }
  }
  function hideLogin() { els.loginScreen.hidden = true; }

  function showAccount() {
    els.accEmail.textContent = currentEmail || "—";
    els.accPartner.textContent = isAdminUser
      ? "Administrador (edita todo)"
      : (currentUser || "(no asignado — solo lectura)");
    els.accountOverlay.classList.add("open");
    els.accountOverlay.setAttribute("aria-hidden", "false");
  }
  function hideAccount() {
    els.accountOverlay.classList.remove("open");
    els.accountOverlay.setAttribute("aria-hidden", "true");
  }

  // Reacciona a la sesión: gate por dominio + identidad por correo.
  async function handleAuth(user) {
    if (!user) {
      currentUser = ""; currentEmail = ""; isAdminUser = false; updateIdentityChip();
      showLogin(authError); authError = "";
      return;
    }
    const email = String(user.email || "").toLowerCase().trim();
    const domain = SupaDeals.allowedDomain || (typeof ALLOWED_DOMAIN !== "undefined" ? ALLOWED_DOMAIN : "mambo.pe");
    if (!emailDomainAllowed(email, domain)) {
      authError = `Acceso restringido al equipo de Mambo. El correo ${email} no pertenece a @${domain}.`;
      await SupaDeals.signOut(); // dispara handleAuth(null) → muestra el login con el error
      return;
    }
    // Autorizado
    hideLogin();
    currentEmail = email;
    isAdminUser = (typeof isAdmin === "function") && isAdmin(email);
    currentUser = partnerForEmail(email); // "" si es admin o no está mapeado
    updateIdentityChip();
    if (!dataLoaded) {
      try {
        deals = await SupaDeals.fetchAll();
        SupaDeals.subscribe(onRealtime);
        dataLoaded = true;
        pruneAndRender();
      } catch (e) {
        console.error("Error leyendo Supabase tras login:", e);
        showBanner("No se pudieron cargar los datos. Recarga la página.");
      }
    } else {
      renderAll();
    }
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

    // "EN JUEGO": suma SOLO las 4 etapas de IN_PLAY_STAGES (nunca Target ni Nurturing),
    // acotado por el partner de "¿Quién eres?" (currentUser) — NO por el filtro de
    // abajo (filters.owner). Sin partner elegido → total de todos los partners.
    const total = deals
      .filter((d) =>
        d.status === "activo" &&
        IN_PLAY_STAGES.has(d.stage) &&
        (!currentUser || d.owner === currentUser))
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
    // El candado solo aparece para correos sin partner (solo lectura). Entre
    // partners ya no hay bloqueo por propietario.
    const lock = locked
      ? `<span class="lock" title="Solo lectura — tu correo no está asignado a un partner">🔒</span>`
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
      ["Tipo de venta", d.saleType],
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
    setCloseDateUI(draft.closeDate);

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

  // Aplica el modo solo-lectura. Ahora solo ocurre para correos @mambo.pe sin
  // partner mapeado (ni admin): los partners editan cualquier negocio.
  function setReadonlyUI(readonly, owner) {
    els.detail.classList.toggle("is-readonly", readonly);
    els.amountInput.disabled = readonly;
    els.probInput.disabled = readonly;
    els.commentInput.disabled = readonly;
    els.closeMonth.disabled = readonly;
    els.closeYear.disabled = readonly;
    els.resultSeg.querySelectorAll(".seg").forEach((b) => { b.disabled = readonly; });
    if (readonly) {
      els.readonlyNotice.hidden = false;
      els.readonlyNotice.textContent = authRequired
        ? "Solo lectura — tu correo no está asignado a un partner."
        : "Solo lectura — elige quién eres para editar los negocios.";
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
    if ((d.closeDate || "") !== (orig.closeDate || "")) c.closeDate = d.closeDate || "";
    if (d.status !== orig.status) {
      c.status = d.status;
      if (d.status === "perdido") c.lossReason = d.lossReason || "";
    } else if (d.status === "perdido" && d.lossReason !== orig.lossReason) {
      c.lossReason = d.lossReason || "";
    }
    return c;
  }

  // Construye filas de actividad (una por campo cambiado) para activity_log.
  function buildActivityRows(orig, d, changes, noteText) {
    const base = {
      actor: currentUser || currentEmail || "",
      actor_email: currentEmail || "",
      pipedrive_id: orig.pipedriveId || null,
      org: orig.org || "",
      title: orig.title || "",
    };
    const rows = [];
    if ("stage" in changes) rows.push({ ...base, field: "Etapa", new_value: (stageById[d.stage] ? stageById[d.stage].label : d.stage) });
    if ("amount" in changes) rows.push({ ...base, field: "Monto", new_value: fmtMoney(d.amount) });
    if ("prob" in changes) rows.push({ ...base, field: "Probabilidad", new_value: probText(d.prob) });
    if ("status" in changes) rows.push({ ...base, field: "Resultado", new_value: d.status === "ganado" ? "Ganado" : (d.status === "perdido" ? ("Perdido (" + (d.lossReason || "") + ")") : "En curso") });
    if ("closeDate" in changes) rows.push({ ...base, field: "Fecha de cierre", new_value: fmtMonthYear(d.closeDate) || "(sin fecha)" });
    if (noteText) rows.push({ ...base, field: "Comentario", new_value: noteText.slice(0, 140) });
    return rows;
  }
  // Registra la actividad del guardado (solo con Supabase; best-effort).
  async function recordActivity(orig, d, changes, noteText) {
    if (mode !== "supabase") return;
    try { await SupaDeals.logActivity(buildActivityRows(orig, d, changes, noteText)); }
    catch (e) { console.warn("No se pudo registrar actividad:", e); }
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
  function isClosed(d) { return d.status === "ganado" || d.status === "perdido"; }

  // Quita el negocio de la vista activa (al cerrarlo: ganado/perdido).
  async function removeDealFromApp(id) {
    if (mode === "supabase") {
      await SupaDeals.deleteDeal(id); // realtime avisará a los demás
    } else {
      const ov = loadDemoOverrides(); delete ov[id];
      localStorage.setItem(STORAGE_DEMO, JSON.stringify(ov));
    }
    deals = deals.filter((d) => d.id !== id);
    clearPendingFor(id);
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
    const closing = draft.status === "ganado" || draft.status === "perdido";

    // 2a) Cerrado Y confirmado → sale de la vista activa (se quita de la app).
    if (res.confirmed && closing) {
      await recordActivity(orig, draft, changes, noteText); // registrar antes de quitarlo
      try {
        await removeDealFromApp(id);
      } catch (e) {
        console.error("Error al quitar el negocio:", e);
        toast("Cerrado en Pipedrive, pero no se pudo quitar de la app. Reintenta.");
        refreshSaveState();
        return;
      }
      closeDetail();
      renderAll();
      toast("Negocio cerrado en Pipedrive; sale de la vista activa ✓");
      return;
    }

    // 2b) Guardar en la app (Supabase o demo). sync_pending = !confirmado (para el cron).
    try {
      if (mode === "supabase") {
        const updated = await SupaDeals.updateDeal(id, draft, !res.confirmed);
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

    // 3) Registrar actividad (adopción de la app) y marcar pendiente sí/no.
    await recordActivity(orig, draft, changes, noteText);
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
      if (isClosed(deal)) {
        // cerrado y ya confirmado → sale de la vista activa
        try { await removeDealFromApp(id); }
        catch (e) { console.error(e); markPending(id, res.remaining); renderList(); toast("Cerrado, pero no se pudo quitar de la app. Reintenta."); return; }
        renderAll();
        toast("Negocio cerrado en Pipedrive; sale de la vista activa ✓");
        return;
      }
      // confirmado normal → limpiar la bandera del cron y el pendiente local
      try { if (mode === "supabase") await SupaDeals.updateDeal(id, deal, false); } catch (_) {}
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
     Crear negocio — catálogos (meta), formulario y envío
     ============================================================ */
  function loadMetaCache() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_META) || "null");
      if (raw && raw.t && (Date.now() - raw.t) < META_TTL_MS && raw.data) return raw.data;
    } catch (_) {}
    return null;
  }
  function saveMetaCache(data) {
    try { localStorage.setItem(STORAGE_META, JSON.stringify({ t: Date.now(), data })); } catch (_) {}
  }

  // Catálogos desde Pipedrive (opciones de campos + organizaciones + partners).
  async function fetchMeta() {
    const token = await SupaDeals.getAccessToken();
    if (!token) throw new Error("Sesión no disponible. Vuelve a iniciar sesión.");
    const r = await fetch("/api/pipedrive-meta", { headers: { Authorization: "Bearer " + token }, cache: "no-store" });
    let j = {};
    try { j = await r.json(); } catch (_) {}
    if (!r.ok || !j.ok) throw new Error(j.error || ("HTTP " + r.status));
    return {
      fields: j.fields || {}, fieldsFound: j.fieldsFound || {},
      organizations: j.organizations || [], partners: j.partners || [],
    };
  }

  // Meta de respaldo (modo demo, o si Pipedrive no responde): opciones a partir de
  // los datos ya cargados. En Supabase NO se usan orgs de aquí (no tienen id).
  function buildDemoMeta() {
    const uniq = (key) => [...new Set(deals.map((d) => d[key]).filter(Boolean))].sort()
      .map((v) => ({ id: v, label: v }));
    const orgs = [...new Set(deals.map((d) => d.org).filter(Boolean))].sort()
      .map((name) => ({ id: null, name }));
    return {
      fields: {
        vertical: uniq("vertical"), client_type: uniq("clientType"),
        sale_type: uniq("saleType"), source: uniq("source"),
        country: COUNTRIES.map((c) => ({ id: c, label: c })), industry: uniq("industry"),
      },
      fieldsFound: {}, organizations: orgs,
      partners: (typeof PARTNERS !== "undefined" ? PARTNERS : []).map((name) => ({ name, userId: null })),
    };
  }

  // Rellena un <select> con opciones (strings o {label}); conserva la selección previa.
  function fillSelect(el, options, emptyLabel) {
    const prev = el.value;
    const opts = (options || []).map((o) => {
      const label = typeof o === "string" ? o : o.label;
      return `<option value="${escapeAttr(label)}">${escapeHtml(label)}</option>`;
    }).join("");
    el.innerHTML = `<option value="">${escapeHtml(emptyLabel || "— Seleccionar —")}</option>` + opts;
    if (prev && [...el.options].some((o) => o.value === prev)) el.value = prev;
  }

  function applyMeta(meta) {
    metaCache = meta;
    createOrg.orgs = meta.organizations || [];
    fillSelect(els.cVertical, meta.fields.vertical, "— Vertical —");
    fillSelect(els.cSource, meta.fields.source, "— Fuente de lead —");
    fillSelect(els.cClientType, meta.fields.client_type, "— Tipo de cliente —");
    fillSelect(els.cSaleType, meta.fields.sale_type, "— Tipo de venta —");
    fillSelect(els.cIndustry, meta.fields.industry, "— Industria —");
    // País siempre fijo (Perú/Ecuador); no se toma de meta para el selector.
    if (createOrg.mode === "existing" && !createOrg.org && !els.cOrgList.hidden) renderOrgList(els.cOrgSearch.value);
  }

  function populateCreateCloseSelects() {
    els.cCloseMonth.innerHTML = '<option value="">— Mes —</option>' +
      MONTHS_ES.map((n, i) => `<option value="${i + 1}">${n}</option>`).join("");
    els.cCloseYear.innerHTML = '<option value="">— Año —</option>' +
      CLOSE_YEARS.map((y) => `<option value="${y}">${y}</option>`).join("");
  }
  function updateCreateClose() {
    const m = els.cCloseMonth.value, y = els.cCloseYear.value;
    createDraft.closeDate = (m && y)
      ? `${y}-${pad2(Number(m))}-${pad2(lastDayOfMonth(Number(y), Number(m)))}` : "";
  }
  function renderCreateStageGrid() {
    els.cStageGrid.innerHTML = STAGES.map((s) =>
      `<button class="stage-opt" data-stage="${s.id}" style="background:${s.bg};color:${s.text}"
        aria-pressed="${createDraft.stage === s.id ? "true" : "false"}">${escapeHtml(s.label)}</button>`
    ).join("");
  }

  /* ---- combobox de organización ---- */
  function renderOrgList(query) {
    const orgs = createOrg.orgs || [];
    const q = (query || "").trim().toLowerCase();
    const matches = (q ? orgs.filter((o) => o.name.toLowerCase().includes(q)) : orgs).slice(0, 60);
    if (!orgs.length) {
      els.cOrgList.innerHTML = `<div class="combo-empty">${mode === "supabase" ? "Cargando organizaciones…" : "Sin organizaciones — usa “Crear nueva”."}</div>`;
    } else if (!matches.length) {
      els.cOrgList.innerHTML = `<div class="combo-empty">Sin resultados. Usa “Crear organización nueva”.</div>`;
    } else {
      els.cOrgList.innerHTML = matches.map((o) =>
        `<button type="button" class="combo-item" data-id="${o.id == null ? "" : o.id}" data-name="${escapeAttr(o.name)}">${escapeHtml(o.name)}</button>`
      ).join("");
    }
    els.cOrgList.hidden = false;
  }
  function selectExistingOrg(org) {
    createOrg.org = org;
    els.cOrgSearch.value = org.name;
    els.cOrgList.hidden = true;
    els.cOrgSelected.hidden = false;
    els.cOrgSelected.innerHTML =
      `<span class="co-badge">✓</span><span>${escapeHtml(org.name)}</span><button type="button" class="co-clear" id="cOrgClear">cambiar</button>`;
  }
  function switchOrgNew() {
    createOrg.mode = "new"; createOrg.org = null;
    els.cOrgExisting.hidden = true;
    els.cOrgSelected.hidden = true;
    els.cOrgList.hidden = true;
    els.cOrgNewWrap.hidden = false;
    els.cOrgNewBtn.hidden = true;
    els.cOrgExistingBtn.hidden = false;
    els.cOrgNewName.focus();
  }
  function switchOrgExisting() {
    createOrg.mode = "existing"; createOrg.org = null;
    els.cOrgNewWrap.hidden = true; els.cOrgNewName.value = "";
    els.cOrgExisting.hidden = false;
    els.cOrgSelected.hidden = true;
    els.cOrgNewBtn.hidden = false;
    els.cOrgExistingBtn.hidden = true;
    els.cOrgSearch.value = ""; els.cOrgList.hidden = true;
  }
  function resolveOrgForSubmit() {
    if (createOrg.mode === "new") {
      const name = els.cOrgNewName.value.trim();
      return name ? { name } : null;
    }
    if (createOrg.org) return createOrg.org.id != null ? { id: createOrg.org.id } : { name: createOrg.org.name };
    return null;
  }

  /* ---- estado del formulario / avisos ---- */
  function showCreateError(msg) {
    els.createError.hidden = false; els.createError.textContent = msg;
    els.createBody.scrollTop = 0;
  }
  function showCreateNotice(msg) {
    if (msg) { els.createSimNotice.hidden = false; els.createSimNotice.textContent = msg; }
    else els.createSimNotice.hidden = true;
  }
  function setCreateBusy(b) {
    creating = b;
    els.createSubmitBtn.disabled = b;
    els.createSubmitBtn.classList.toggle("is-busy", b);
    els.createSubmitBtn.textContent = b ? "Creando…" : "Crear negocio";
  }

  function resetCreateForm() {
    setCreateBusy(false);
    els.createError.hidden = true;
    showCreateNotice("");
    els.cTitle.value = "";
    createDraft = { stage: "target", prob: null, closeDate: "" };
    renderCreateStageGrid();
    els.cAmount.value = 0;
    els.cProb.value = 0;
    els.cProbVal.textContent = "Sin definir"; els.cProbVal.classList.add("null");
    populateCreateCloseSelects();
    els.cCloseMonth.value = ""; els.cCloseYear.value = "";
    fillSelect(els.cCountry, COUNTRIES, "— País —");
    // placeholders hasta que llegue meta
    fillSelect(els.cVertical, [], "— Vertical —");
    fillSelect(els.cSource, [], "— Fuente de lead —");
    fillSelect(els.cClientType, [], "— Tipo de cliente —");
    fillSelect(els.cSaleType, [], "— Tipo de venta —");
    fillSelect(els.cIndustry, [], "— Industria —");
    els.cIndustryHint.hidden = false;
    els.cContactName.value = ""; els.cContactPhone.value = ""; els.cContactEmail.value = "";
    // propietario: admin elige; partner queda implícito (su identidad)
    if (isAdminUser) {
      els.cOwnerField.hidden = false;
      const partners = (typeof PARTNERS !== "undefined" ? PARTNERS : []);
      els.cOwner.innerHTML = partners.map((p) => `<option value="${escapeAttr(p)}">${escapeHtml(p)}</option>`).join("");
    } else {
      els.cOwnerField.hidden = true;
    }
    switchOrgExisting();
  }

  function openCreate() {
    if (!canCreate()) return;
    resetCreateForm();
    els.createPanel.classList.add("open");
    els.createPanel.setAttribute("aria-hidden", "false");
    els.createBody.scrollTop = 0;

    const cached = loadMetaCache();
    if (cached) applyMeta(cached);
    (async () => {
      try {
        const meta = (mode === "supabase") ? await fetchMeta() : buildDemoMeta();
        saveMetaCache(meta);
        applyMeta(meta);
      } catch (e) {
        console.warn("No se pudieron cargar catálogos:", e);
        if (!cached) {
          const fb = buildDemoMeta();
          if (mode === "supabase") fb.organizations = []; // orgs sin id no sirven para vincular
          applyMeta(fb);
          if (mode === "supabase") showCreateNotice("No pude cargar la lista de organizaciones de Pipedrive. Puedes crear una nueva; reintenta más tarde para elegir existentes.");
        }
      }
    })();
  }
  function closeCreate() {
    els.createPanel.classList.remove("open");
    els.createPanel.setAttribute("aria-hidden", "true");
    creating = false;
  }

  // Registra la creación en activity_log (adopción). Best-effort.
  async function recordCreation(deal) {
    if (mode !== "supabase") return;
    const rows = [{
      actor: currentUser || currentEmail || "",
      actor_email: currentEmail || "",
      pipedrive_id: deal.pipedriveId || null,
      org: deal.org || "", title: deal.title || "",
      field: "Creación",
      new_value: "Negocio creado" + (deal.amount ? " · " + fmtMoney(deal.amount) : ""),
    }];
    try { await SupaDeals.logActivity(rows); } catch (e) { console.warn("No se pudo registrar la creación:", e); }
  }

  async function submitCreate() {
    if (creating) return;
    els.createError.hidden = true;
    const title = els.cTitle.value.trim();
    if (!title) return showCreateError("El título es obligatorio.");
    const org = resolveOrgForSubmit();
    if (!org) return showCreateError("Elige una organización existente o escribe el nombre de una nueva.");
    const owner = isAdminUser ? (els.cOwner.value || "") : currentUser;
    if (!owner) return showCreateError("No hay propietario asignado.");

    const fields = {
      vertical: els.cVertical.value, client_type: els.cClientType.value,
      sale_type: els.cSaleType.value, source: els.cSource.value,
      country: els.cCountry.value, industry: els.cIndustry.value,
    };
    const cName = els.cContactName.value.trim();
    const contact = cName
      ? { name: cName, phone: els.cContactPhone.value.trim(), email: els.cContactEmail.value.trim() }
      : null;
    const amount = Number(els.cAmount.value) || 0;
    const payload = {
      title, owner, stage: createDraft.stage, amount, prob: createDraft.prob,
      closeDate: createDraft.closeDate || "", org, contact, fields,
    };

    setCreateBusy(true);

    if (mode === "supabase") {
      try {
        const token = await SupaDeals.getAccessToken();
        const r = await fetch("/api/pipedrive-create", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
          body: JSON.stringify(payload),
        });
        let j = {};
        try { j = await r.json(); } catch (_) {}
        if (!r.ok || !j.ok) throw new Error(j.error || ("HTTP " + r.status));

        if (j.simulated) {
          setCreateBusy(false);
          showCreateNotice("Simulado: NO se creó en Pipedrive. Activa PIPEDRIVE_CREATE_ENABLED=true para crear de verdad.");
          return;
        }

        let row;
        try { row = await SupaDeals.createDeal(j.deal); }
        catch (e) {
          console.error("Insert Supabase falló tras crear en Pipedrive:", e);
          setCreateBusy(false);
          return showCreateError("Se creó en Pipedrive, pero no se pudo guardar en la app (" + (e.message || e) + "). El próximo sync lo traerá.");
        }
        applyDeal(row);
        lastWrite = { id: row.id, t: Date.now() };
        await recordCreation(row);

        // añade la nueva org al catálogo cacheado (para próximas creaciones sin recargar)
        if (org.name && metaCache) {
          metaCache.organizations = [{ id: j.orgId, name: row.org }].concat(metaCache.organizations || []);
          saveMetaCache(metaCache);
        }

        if (j.warnings && j.warnings.length) console.warn("[crear] avisos:", j.warnings);
        closeCreate();
        renderOwnerFilter();
        renderAll();
        toast("Negocio creado en Pipedrive ✓" + (j.warnings && j.warnings.length ? " (con avisos)" : ""));
      } catch (e) {
        setCreateBusy(false);
        showCreateError(e.message || "No se pudo crear el negocio.");
      }
    } else {
      // modo demo: negocio local (persiste en localStorage)
      const deal = normalize({
        id: -Date.now(), pipedriveId: null,
        org: org.name || "", title, owner,
        stage: createDraft.stage, amount, prob: createDraft.prob,
        vertical: fields.vertical, clientType: fields.client_type, saleType: fields.sale_type,
        source: fields.source, industry: fields.industry, closeDate: createDraft.closeDate || "",
      });
      const arr = loadDemoCreated(); arr.push(deal); saveDemoCreated(arr);
      applyDeal(deal);
      setCreateBusy(false);
      closeCreate();
      renderOwnerFilter();
      renderAll();
      toast("Negocio creado (demo local) ✓");
    }
  }

  /* ============================================================
     Revisión semanal — "Terminé de revisar"
     ============================================================ */
  // Lunes de la semana actual en hora Perú (UTC-5 fijo), "YYYY-MM-DD".
  // Misma lógica que api/_week.js para que cliente y servidor coincidan.
  function peruWeekStart() {
    const w = new Date(Date.now() + (-300) * 60000); // desplaza a "pared" Perú; leer con getUTC*
    const day = w.getUTCDay();               // 0=dom … 6=sáb
    const diff = day === 0 ? 6 : day - 1;    // días desde el lunes
    const mon = new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate() - diff));
    return `${mon.getUTCFullYear()}-${String(mon.getUTCMonth() + 1).padStart(2, "0")}-${String(mon.getUTCDate()).padStart(2, "0")}`;
  }

  // Modo demo: estado de revisión en localStorage { [week]: { [partner]: {confirmed,no_count,last} } }.
  function demoRecordReview(partner, week, answer) {
    let all = {};
    try { all = JSON.parse(localStorage.getItem(STORAGE_REVIEW) || "{}"); } catch (_) {}
    const wk = all[week] || (all[week] = {});
    const cur = wk[partner] || { confirmed: false, no_count: 0, last: "" };
    cur.confirmed = cur.confirmed || answer === "si";
    if (answer === "no") cur.no_count += 1;
    cur.last = answer;
    wk[partner] = cur;
    localStorage.setItem(STORAGE_REVIEW, JSON.stringify(all));
    return { no_count: cur.no_count, confirmed: cur.confirmed, last_status: cur.last };
  }

  function showReview() {
    if (!currentUser) return;
    els.reviewOverlay.classList.add("open");
    els.reviewOverlay.setAttribute("aria-hidden", "false");
  }
  function hideReview() {
    els.reviewOverlay.classList.remove("open");
    els.reviewOverlay.setAttribute("aria-hidden", "true");
  }
  function showReviewWarn() {
    els.reviewWarnOverlay.classList.add("open");
    els.reviewWarnOverlay.setAttribute("aria-hidden", "false");
  }
  function hideReviewWarn() {
    els.reviewWarnOverlay.classList.remove("open");
    els.reviewWarnOverlay.setAttribute("aria-hidden", "true");
  }

  async function submitReview(answer) {
    const partner = currentUser;
    if (!partner) return;
    const week = peruWeekStart();
    // evita doble envío mientras responde
    els.reviewYesBtn.disabled = true; els.reviewNoBtn.disabled = true;
    let result;
    try {
      result = (mode === "supabase")
        ? await SupaDeals.recordReview(partner, currentEmail, week, answer)
        : demoRecordReview(partner, week, answer);
    } catch (e) {
      console.error("No se pudo registrar la revisión:", e);
      els.reviewYesBtn.disabled = false; els.reviewNoBtn.disabled = false;
      toast("No se pudo registrar. Reintenta.");
      return;
    }
    els.reviewYesBtn.disabled = false; els.reviewNoBtn.disabled = false;
    hideReview();
    if (answer === "si") {
      toast("¡Gracias! Revisión registrada ✓");
    } else {
      toast("Anotado. Recuerda actualizar tu base.");
      // A la SEGUNDA vez (o más) que dice "No" en la semana → advertencia.
      if (result && Number(result.no_count) >= 2) showReviewWarn();
    }
  }

  /* ============================================================
     Realtime — cambios de otros partners
     ============================================================ */
  function onRealtime(type, deal, oldId) {
    if (type === "DELETE") {
      deals = deals.filter((d) => d.id !== oldId);
      pendingIds.delete(oldId);
      delete pendingMeta[oldId];
      savePending(); savePendingMeta();
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

    // identidad: con login → panel de cuenta; en demo → selector manual
    els.identityChip.addEventListener("click", () => { authRequired ? showAccount() : showIdentity(); });
    els.ownerList.addEventListener("click", (e) => {
      const b = e.target.closest(".id-owner");
      if (b) chooseUser(b.dataset.owner);
    });
    // login / logout
    els.googleBtn.addEventListener("click", async () => {
      els.googleBtn.disabled = true;
      const redirectTo = window.location.origin + window.location.pathname;
      const domain = SupaDeals.allowedDomain || (typeof ALLOWED_DOMAIN !== "undefined" ? ALLOWED_DOMAIN : "");
      try { await SupaDeals.signInWithGoogle(redirectTo, domain); }
      catch (e) { console.error(e); showLogin("No se pudo iniciar sesión. Reintenta."); els.googleBtn.disabled = false; }
    });
    els.logoutBtn.addEventListener("click", async () => {
      hideAccount();
      dataLoaded = false;
      await SupaDeals.signOut(); // onAuth(null) → showLogin
    });
    els.accountCloseBtn.addEventListener("click", hideAccount);

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
    els.closeMonth.addEventListener("change", () => { if (draftEditable) updateCloseDraft(); });
    els.closeYear.addEventListener("change", () => { if (draftEditable) updateCloseDraft(); });

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

    /* ---- crear negocio ---- */
    els.addDealBtn.addEventListener("click", openCreate);
    els.createBackBtn.addEventListener("click", closeCreate);
    els.createCancelBtn.addEventListener("click", closeCreate);
    els.createSubmitBtn.addEventListener("click", submitCreate);
    els.cProb.addEventListener("input", (e) => {
      createDraft.prob = Number(e.target.value);
      els.cProbVal.textContent = createDraft.prob + "%";
      els.cProbVal.classList.remove("null");
    });
    els.cStageGrid.addEventListener("click", (e) => {
      const opt = e.target.closest(".stage-opt");
      if (!opt) return;
      createDraft.stage = opt.dataset.stage;
      els.cStageGrid.querySelectorAll(".stage-opt").forEach((b) =>
        b.setAttribute("aria-pressed", b.dataset.stage === createDraft.stage ? "true" : "false"));
    });
    els.cCloseMonth.addEventListener("change", updateCreateClose);
    els.cCloseYear.addEventListener("change", updateCreateClose);
    // combobox organización
    els.cOrgSearch.addEventListener("input", (e) => {
      createOrg.org = null; els.cOrgSelected.hidden = true;
      renderOrgList(e.target.value);
    });
    els.cOrgSearch.addEventListener("focus", () => {
      if (createOrg.mode === "existing") renderOrgList(els.cOrgSearch.value);
    });
    els.cOrgList.addEventListener("click", (e) => {
      const it = e.target.closest(".combo-item");
      if (!it) return;
      selectExistingOrg({ id: it.dataset.id ? Number(it.dataset.id) : null, name: it.dataset.name });
    });
    els.cOrgSelected.addEventListener("click", (e) => {
      if (!e.target.closest("#cOrgClear")) return;
      createOrg.org = null; els.cOrgSearch.value = ""; els.cOrgSelected.hidden = true;
      renderOrgList(""); els.cOrgSearch.focus();
    });
    els.cOrgNewBtn.addEventListener("click", switchOrgNew);
    els.cOrgExistingBtn.addEventListener("click", switchOrgExisting);

    /* ---- revisión semanal ---- */
    els.reviewDoneBtn.addEventListener("click", showReview);
    els.reviewYesBtn.addEventListener("click", () => submitReview("si"));
    els.reviewNoBtn.addEventListener("click", () => submitReview("no"));
    els.reviewWarnOkBtn.addEventListener("click", hideReviewWarn);
    // cerrar la lista al hacer click fuera del combobox
    document.addEventListener("click", (e) => {
      if (els.createPanel.classList.contains("open") &&
          createOrg.mode === "existing" &&
          !els.cOrgExisting.contains(e.target)) {
        els.cOrgList.hidden = true;
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (els.reviewWarnOverlay.classList.contains("open")) hideReviewWarn();
      else if (els.reviewOverlay.classList.contains("open")) hideReview();
      else if (els.identityOverlay.classList.contains("open")) { if (currentUser) hideIdentity(); }
      else if (els.createPanel.classList.contains("open")) closeCreate();
      else if (els.detail.classList.contains("open")) closeDetail();
    });
  }

  /* ============================================================
     Arranque
     ============================================================ */
  // Limpia pendientes huérfanos y pinta. Se usa tras cargar datos (login o demo).
  function pruneAndRender() {
    const validIds = new Set(deals.map((d) => d.id));
    [...pendingIds].forEach((id) => { if (!validIds.has(id)) pendingIds.delete(id); });
    Object.keys(pendingMeta).forEach((k) => { if (!validIds.has(Number(k))) delete pendingMeta[k]; });
    savePending(); savePendingMeta();
    renderOwnerFilter();
    renderAll();
  }

  async function boot() {
    let connected = false;
    try { connected = await SupaDeals.init(); } catch (e) { console.error(e); }

    if (connected) {
      // Con Supabase → LOGIN OBLIGATORIO. handleAuth carga los datos al autenticar.
      mode = "supabase";
      authRequired = true;
      hideBanner();
      SupaDeals.onAuth(handleAuth); // dispara la sesión inicial y cada cambio (incl. redirect de Google)
    } else {
      // Sin Supabase → modo demo local (sin login), conserva el selector manual.
      mode = "demo";
      authRequired = false;
      deals = seedDemoDeals();
      showBanner("Modo demo (sin Supabase). Configura las variables de entorno para datos compartidos.");
      pruneAndRender();
      if (!currentUser) showIdentity();
    }
  }

  async function init() {
    renderStageChips();
    populateCloseSelects();
    bindEvents();
    updateIdentityChip();
    await boot();
  }

  document.addEventListener("DOMContentLoaded", init);
})();

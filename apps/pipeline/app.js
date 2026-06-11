/* ============================================================
   mambo · App de Pipeline — lógica
   Vanilla JS · persistencia en localStorage · sin backend (piloto)
   ============================================================ */
(function () {
  "use strict";

  const STORAGE_KEY = "mambo.pipeline.v1";
  const stageById = Object.fromEntries(STAGES.map((s) => [s.id, s]));

  /* ---------- estado ---------- */
  let deals = [];          // estado vigente (editable)
  let original = {};       // snapshot original por id (para detectar cambios y reiniciar)
  let filters = { owner: "", stage: "", text: "", showLost: false };
  let editingId = null;    // id del negocio abierto en detalle
  let draft = null;        // copia de trabajo del negocio en edición

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
    exportFab: $("exportFab"),
    fabCount: $("fabCount"),
    // detalle
    detail: $("detail"),
    dOrg: $("dOrg"),
    dTitle: $("dTitle"),
    dTags: $("dTags"),
    stageGrid: $("stageGrid"),
    amountInput: $("amountInput"),
    probInput: $("probInput"),
    probVal: $("probVal"),
    commentInput: $("commentInput"),
    lostSwitch: $("lostSwitch"),
    lossReasons: $("lossReasons"),
    reasonChips: $("reasonChips"),
    lossError: $("lossError"),
    saveBtn: $("saveBtn"),
    cancelBtn: $("cancelBtn"),
    backBtn: $("backBtn"),
    // sheet
    scrim: $("scrim"),
    sheet: $("sheet"),
    sheetSub: $("sheetSub"),
    sheetList: $("sheetList"),
    copyBtn: $("copyBtn"),
    csvBtn: $("csvBtn"),
    resetBtn: $("resetBtn"),
    // import
    importBtn: $("importBtn"),
    csvInput: $("csvInput"),
    toast: $("toast"),
  };

  /* ============================================================
     Persistencia
     ============================================================ */
  function load() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        deals = parsed.deals || [];
        original = parsed.original || {};
        if (deals.length) return;
      } catch (_) { /* cae al seed */ }
    }
    seedFrom(SEED_DEALS);
  }

  function seedFrom(source) {
    deals = source.map((d) => normalize(d));
    original = {};
    deals.forEach((d) => { original[d.id] = snapshot(d); });
    persist();
  }

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ deals, original }));
  }

  // Solo los campos editables cuentan como "cambio"
  function snapshot(d) {
    return {
      stage: d.stage, amount: d.amount, prob: d.prob,
      comment: d.comment, status: d.status, lossReason: d.lossReason,
    };
  }

  function normalize(d) {
    return {
      id: d.id,
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

  /* ============================================================
     Detección de cambios
     ============================================================ */
  function isChanged(d) {
    const o = original[d.id];
    if (!o) return true;
    const s = snapshot(d);
    return Object.keys(s).some((k) => s[k] !== o[k]);
  }

  function changedDeals() {
    return deals.filter(isChanged);
  }

  /* ============================================================
     Helpers de formato
     ============================================================ */
  function fmtMoney(n) {
    if (!n) return "US$0";
    return "US$" + Number(n).toLocaleString("en-US");
  }
  function initials(name) {
    return name.split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase();
  }
  function probText(p) { return p === null ? "—" : p + "%"; }

  /* ============================================================
     Render — header / stats
     ============================================================ */
  function renderStats() {
    const changed = changedDeals();
    els.changeCount.textContent = changed.length;
    els.statChanges.classList.toggle("changed", changed.length > 0);

    // "En juego" = suma de montos de negocios activos (no perdidos)
    const total = deals
      .filter((d) => d.status !== "perdido")
      .reduce((sum, d) => sum + (d.amount || 0), 0);
    els.totalAmount.textContent = fmtMoney(total);

    const n = changed.length;
    els.exportFab.hidden = n === 0;
    els.fabCount.textContent = n;
  }

  /* ============================================================
     Render — filtros
     ============================================================ */
  function renderOwnerFilter() {
    const owners = [...new Set(deals.map((d) => d.owner))].sort();
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
    const changed = isChanged(d) ? " is-changed" : "";
    const lost = d.status === "perdido";
    const badge = lost
      ? `<span class="badge lost">Perdido</span>`
      : `<span class="badge" style="background:${st.bg};color:${st.text}">${escapeHtml(st.label)}</span>`;

    return `
      <button class="deal-card${changed}${lost ? " is-lost" : ""}" data-id="${d.id}">
        <div>
          <div class="deal-org">${escapeHtml(d.org)}</div>
          <div class="deal-title">${escapeHtml(d.title)}</div>
        </div>
        <div class="avatar" title="${escapeAttr(d.owner)}">${initials(d.owner)}</div>
        <div class="deal-meta">
          ${badge}
          <span class="deal-amount">${fmtMoney(d.amount)}</span>
          <span class="deal-prob">${probText(d.prob)}</span>
        </div>
      </button>`;
  }

  /* ============================================================
     Detalle / edición (pantalla 02 + 03)
     ============================================================ */
  function openDetail(id) {
    const d = deals.find((x) => x.id === id);
    if (!d) return;
    editingId = id;
    draft = { ...d };

    els.dOrg.textContent = d.org;
    els.dTitle.textContent = d.title;

    // tags read-only
    const tags = [
      ["Vertical", d.vertical],
      ["Cliente", d.clientType],
      ["Industria", d.industry],
      ["Origen", d.source],
    ].filter(([, v]) => v);
    els.dTags.innerHTML = tags
      .map(([k, v]) => `<span class="tag"><span class="k">${k}:</span> ${escapeHtml(v)}</span>`)
      .join("");

    // selector visual de etapa
    els.stageGrid.innerHTML = STAGES.map((s) =>
      `<button class="stage-opt" data-stage="${s.id}"
        style="background:${s.bg};color:${s.text}"
        aria-pressed="${draft.stage === s.id ? "true" : "false"}">${escapeHtml(s.label)}</button>`
    ).join("");

    els.amountInput.value = draft.amount || 0;
    els.probInput.value = draft.prob === null ? 0 : draft.prob;
    updateProbLabel(draft.prob);
    els.commentInput.value = draft.comment || "";

    // bloque perdido
    setLostUI(draft.status === "perdido");
    renderReasonChips();
    els.lossError.classList.remove("show");

    refreshSaveState();
    els.detail.classList.add("open");
    els.detail.setAttribute("aria-hidden", "false");
    document.getElementById("detailBody").scrollTop = 0;
  }

  function closeDetail() {
    els.detail.classList.remove("open");
    els.detail.setAttribute("aria-hidden", "true");
    editingId = null;
    draft = null;
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

  function setLostUI(isLost) {
    els.lostSwitch.setAttribute("aria-pressed", isLost ? "true" : "false");
    els.lossReasons.classList.toggle("hidden", !isLost);
  }

  function renderReasonChips() {
    els.reasonChips.innerHTML = LOSS_REASONS.map((r) =>
      `<button class="reason-chip" data-reason="${escapeAttr(r)}"
        aria-pressed="${draft.lossReason === r ? "true" : "false"}">${escapeHtml(r)}</button>`
    ).join("");
  }

  // Criterio 2: marcar perdido exige motivo; sin él, se bloquea el guardado.
  function canSave() {
    if (!draft) return false;
    if (draft.status === "perdido" && !draft.lossReason) return false;
    return true;
  }
  function refreshSaveState() {
    els.saveBtn.disabled = !canSave();
  }

  function saveDraft() {
    if (!canSave()) {
      els.lossError.classList.add("show");
      return;
    }
    const idx = deals.findIndex((x) => x.id === editingId);
    if (idx >= 0) {
      // si deja de estar perdido, limpiar motivo
      if (draft.status !== "perdido") draft.lossReason = "";
      deals[idx] = { ...draft };
      persist();
    }
    closeDetail();
    renderAll();
    toast("Cambios guardados");
  }

  /* ============================================================
     Bottom sheet — exportar (pantalla 04)
     ============================================================ */
  function openSheet() {
    renderSheet();
    els.scrim.classList.add("open");
    els.sheet.classList.add("open");
    els.sheet.setAttribute("aria-hidden", "false");
  }
  function closeSheet() {
    els.scrim.classList.remove("open");
    els.sheet.classList.remove("open");
    els.sheet.setAttribute("aria-hidden", "true");
  }

  function renderSheet() {
    const changed = changedDeals();
    els.sheetSub.textContent =
      changed.length + (changed.length === 1 ? " negocio modificado" : " negocios modificados");
    els.sheetList.innerHTML = changed.map((d) => {
      const st = stageById[d.stage];
      const etapa = d.status === "perdido"
        ? `PERDIDO (${escapeHtml(d.lossReason)})`
        : escapeHtml(st ? st.label : d.stage);
      return `
        <div class="change-item">
          <div class="ci-title">${escapeHtml(d.org)} – ${escapeHtml(d.title)}</div>
          <div class="ci-line">Etapa: ${etapa}</div>
          <div class="ci-line mono">${fmtMoney(d.amount)} · Prob: ${probText(d.prob)}</div>
        </div>`;
    }).join("") || '<div class="empty">No hay cambios para exportar.</div>';
  }

  /* ---------- resumen de texto (WhatsApp) ----------
     {org} – {title} | Etapa: {etapa o "PERDIDO (motivo)"} | Monto: {n} | Prob: {n%} | Comentario: {texto}
  */
  function buildSummary() {
    return changedDeals().map((d) => {
      const st = stageById[d.stage];
      const etapa = d.status === "perdido"
        ? `PERDIDO (${d.lossReason})`
        : (st ? st.label : d.stage);
      return `${d.org} – ${d.title} | Etapa: ${etapa} | Monto: ${fmtMoney(d.amount)} | Prob: ${probText(d.prob)} | Comentario: ${d.comment || "—"}`;
    }).join("\n");
  }

  function copySummary() {
    const text = buildSummary();
    if (!text) { toast("No hay cambios"); return; }
    navigator.clipboard.writeText(text).then(
      () => toast("Resumen copiado"),
      () => { fallbackCopy(text); toast("Resumen copiado"); }
    );
  }
  function fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (_) {}
    document.body.removeChild(ta);
  }

  /* ---------- CSV (UTF-8 con BOM) ----------
     Columnas: Organización · Título · Propietario · Etapa · Monto ·
     Probabilidad · Comentario · Estado · Motivo de pérdida
  */
  function downloadCsv() {
    const changed = changedDeals();
    if (!changed.length) { toast("No hay cambios"); return; }
    const headers = ["Organización","Título","Propietario","Etapa","Monto","Probabilidad","Comentario","Estado","Motivo de pérdida"];
    const rows = changed.map((d) => {
      const st = stageById[d.stage];
      return [
        d.org,
        d.title,
        d.owner,
        st ? st.label : d.stage,
        d.amount,
        d.prob === null ? "" : d.prob,
        d.comment,
        d.status,
        d.lossReason,
      ];
    });
    const csv = [headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" }); // BOM
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "pipeline-cambios.csv";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast("CSV descargado");
  }
  function csvCell(v) {
    const s = String(v ?? "");
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /* ---------- reiniciar (criterio 5) ---------- */
  function resetChanges() {
    if (!changedDeals().length) { toast("Nada que reiniciar"); return; }
    if (!confirm("¿Reiniciar todos los cambios a su estado original?")) return;
    deals = deals.map((d) => {
      const o = original[d.id];
      return o ? { ...d, ...o } : d;
    });
    persist();
    closeSheet();
    renderAll();
    toast("Cambios reiniciados");
  }

  /* ============================================================
     Import CSV de Pipedrive (PapaParse)
     ============================================================ */
  // Mapeo flexible de cabeceras comunes de Pipedrive → modelo
  const HEADER_MAP = {
    org: ["organización","organizacion","organization","org","empresa","cliente"],
    title: ["título","titulo","title","deal","negocio","nombre del trato","nombre"],
    owner: ["propietario","owner","dueño","dueno","gerente","responsable"],
    stage: ["etapa","stage","fase"],
    amount: ["monto","amount","valor","value","importe"],
    prob: ["probabilidad","probability","prob"],
    vertical: ["vertical"],
    clientType: ["tipo de cliente","clienttype","client type"],
    industry: ["industria","industry","sector"],
    source: ["origen","source","lead source","fuente"],
    closeDate: ["fecha de cierre","closedate","close date","cierre esperado"],
  };
  const stageByLabel = Object.fromEntries(STAGES.map((s) => [s.label.toLowerCase(), s.id]));

  function pickField(rowKeys, lowerRow, candidates) {
    for (const c of candidates) {
      const k = rowKeys.find((rk) => rk.trim().toLowerCase() === c);
      if (k) return lowerRow[k.trim().toLowerCase()];
    }
    return "";
  }

  function importCsv(file) {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const imported = res.data.map((raw, i) => {
          const lowerRow = {};
          Object.keys(raw).forEach((k) => { lowerRow[k.trim().toLowerCase()] = raw[k]; });
          const keys = Object.keys(raw);
          const stageRaw = String(pickField(keys, lowerRow, HEADER_MAP.stage) || "").trim().toLowerCase();
          const stageId = stageById[stageRaw] ? stageRaw : (stageByLabel[stageRaw] || "target");
          const probRaw = pickField(keys, lowerRow, HEADER_MAP.prob);
          return normalize({
            id: i + 1,
            org: pickField(keys, lowerRow, HEADER_MAP.org),
            title: pickField(keys, lowerRow, HEADER_MAP.title),
            owner: pickField(keys, lowerRow, HEADER_MAP.owner),
            stage: stageId,
            amount: String(pickField(keys, lowerRow, HEADER_MAP.amount) || "").replace(/[^\d.-]/g, ""),
            prob: probRaw === "" || probRaw == null ? null : probRaw,
            vertical: pickField(keys, lowerRow, HEADER_MAP.vertical),
            clientType: pickField(keys, lowerRow, HEADER_MAP.clientType),
            industry: pickField(keys, lowerRow, HEADER_MAP.industry),
            source: pickField(keys, lowerRow, HEADER_MAP.source),
            closeDate: pickField(keys, lowerRow, HEADER_MAP.closeDate),
          });
        }).filter((d) => d.org || d.title);

        if (!imported.length) { toast("CSV sin filas válidas"); return; }
        seedFrom(imported);
        filters = { owner: "", stage: "", text: "", showLost: false };
        els.search.value = "";
        renderAll();
        toast(`${imported.length} negocios importados`);
      },
      error: () => toast("Error al leer el CSV"),
    });
  }

  /* ============================================================
     Toast
     ============================================================ */
  let toastTimer = null;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2000);
  }

  /* ============================================================
     Escape helpers
     ============================================================ */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  /* ============================================================
     Render maestro
     ============================================================ */
  function renderAll() {
    renderStats();
    renderList();
  }

  /* ============================================================
     Eventos
     ============================================================ */
  function bindEvents() {
    // lista → abrir detalle
    els.list.addEventListener("click", (e) => {
      const card = e.target.closest(".deal-card");
      if (card) openDetail(Number(card.dataset.id));
    });

    // filtros
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

    // detalle: etapa
    els.stageGrid.addEventListener("click", (e) => {
      const opt = e.target.closest(".stage-opt");
      if (!opt) return;
      draft.stage = opt.dataset.stage;
      els.stageGrid.querySelectorAll(".stage-opt").forEach((b) =>
        b.setAttribute("aria-pressed", b.dataset.stage === draft.stage ? "true" : "false"));
    });
    // detalle: campos
    els.amountInput.addEventListener("input", (e) => {
      draft.amount = Number(e.target.value) || 0;
    });
    els.probInput.addEventListener("input", (e) => {
      draft.prob = Number(e.target.value);
      updateProbLabel(draft.prob);
    });
    els.commentInput.addEventListener("input", (e) => { draft.comment = e.target.value; });

    // detalle: perdido
    els.lostSwitch.addEventListener("click", () => {
      const nowLost = els.lostSwitch.getAttribute("aria-pressed") !== "true";
      draft.status = nowLost ? "perdido" : "activo";
      if (!nowLost) { draft.lossReason = ""; }
      setLostUI(nowLost);
      renderReasonChips();
      // Criterio 2: al marcar perdido sin motivo, mostrar el error visible y bloquear guardado.
      els.lossError.classList.toggle("show", nowLost && !draft.lossReason);
      refreshSaveState();
    });
    els.reasonChips.addEventListener("click", (e) => {
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

    // sheet
    els.exportFab.addEventListener("click", openSheet);
    els.scrim.addEventListener("click", closeSheet);
    els.copyBtn.addEventListener("click", copySummary);
    els.csvBtn.addEventListener("click", downloadCsv);
    els.resetBtn.addEventListener("click", resetChanges);

    // import
    els.importBtn.addEventListener("click", () => els.csvInput.click());
    els.csvInput.addEventListener("change", (e) => {
      const f = e.target.files[0];
      if (f) importCsv(f);
      e.target.value = "";
    });

    // esc cierra capas
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (els.sheet.classList.contains("open")) closeSheet();
      else if (els.detail.classList.contains("open")) closeDetail();
    });
  }

  /* ============================================================
     Init
     ============================================================ */
  function init() {
    load();
    renderOwnerFilter();
    renderStageChips();
    renderAll();
    bindEvents();
  }

  document.addEventListener("DOMContentLoaded", init);
})();

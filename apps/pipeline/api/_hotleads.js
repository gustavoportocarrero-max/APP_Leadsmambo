// ============================================================
// mambo · Pipeline — leads "calientes" (criterio compartido)
//
// Módulo auxiliar ("_" → no es ruta). Lo usa hot-leads.js (acciones email y
// status) para calcular EXACTAMENTE el mismo conjunto de leads calientes.
//
// Un negocio del pipeline 1 es lead caliente si (los tres a la vez):
//   probabilidad >= 75, etapa "Follow-up y cierre" (stage 55), y la fecha de
//   cierre prevista cae en el mes indicado (ym = "YYYY-MM", hora Perú).
// ============================================================

export const HOT = { PIPELINE: 1, STAGE_CIERRE: 55, MIN_PROB: 75 };
const MESES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

const norm = (s) => (s || "").toString().toLowerCase().trim();
const ownerNameOf = (d) => (d.owner_name || (d.user_id && d.user_id.name) || "").toString();
const orgNameOf = (d) => (d.org_name || (d.org_id && d.org_id.name) || "").toString();
function fmtMonthYear(dateStr) { const [y, m] = String(dateStr || "").split("-"); return `${MESES[Number(m) - 1] || m} ${y}`; }
function fmtMoney(n) { return "US$" + (Number(n) || 0).toLocaleString("en-US"); }

export async function fetchP1OpenDeals(pd) {
  const out = []; let s = 0;
  for (let g = 0; g < 100; g++) {
    const j = await pd.get(`/pipelines/${HOT.PIPELINE}/deals`, { status: "open", limit: "500", start: String(s) });
    (j.data || []).forEach((d) => { if (Number(d.pipeline_id) === HOT.PIPELINE) out.push(d); });
    const pag = j.additional_data && j.additional_data.pagination;
    if (pag && pag.more_items_in_collection) s = pag.next_start; else break;
  }
  return out;
}

// Devuelve { [partner]: [{ id, title, org, money, closeLabel }] } (solo partners de la lista).
export async function fetchHotLeadsByPartner(pd, partnersList, ym) {
  const wanted = new Set(partnersList.map(norm));
  const disp = {}; partnersList.forEach((p) => { disp[norm(p)] = p; });
  const byPartner = {}; partnersList.forEach((p) => { byPartner[p] = []; });

  const deals = await fetchP1OpenDeals(pd);
  for (const d of deals) {
    const on = norm(ownerNameOf(d));
    if (!wanted.has(on)) continue;
    const prob = Number(d.probability);
    const closeYM = (d.expected_close_date || "").slice(0, 7);
    if (!(prob >= HOT.MIN_PROB && Number(d.stage_id) === HOT.STAGE_CIERRE && closeYM === ym)) continue;
    byPartner[disp[on]].push({
      id: Number(d.id),
      title: (d.title || "(sin título)").toString(),
      org: orgNameOf(d),
      money: fmtMoney(d.value),
      closeLabel: fmtMonthYear(d.expected_close_date),
    });
  }
  return byPartner;
}

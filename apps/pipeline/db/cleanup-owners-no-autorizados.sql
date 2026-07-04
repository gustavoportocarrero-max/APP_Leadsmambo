-- ============================================================
-- Limpieza: quitar de Supabase los negocios cuyo PROPIETARIO no está en la
-- lista blanca (p. ej. propietario "Topless" o "Esteban Bustamante").
-- NO toca Pipedrive. NO borra los válidos ni los que tienen cambios pendientes.
--
-- ORDEN DE USO:
--   1) Corre el PASO 1 (SELECT) y revisa la columna "accion": confirma que
--      MANTENER son solo tus 5 propietarios y BORRAR son los no deseados.
--   2) Si se ve bien, corre el PASO 2 (DELETE).
--   3) Corre el PASO 3 (verificación): deben quedar solo los 5 autorizados.
-- ============================================================

-- ---------- PASO 1 · PREVIEW (no borra nada) ----------
select
  owner,
  count(*) as negocios,
  case
    when owner in ('Nicolás Aramburú','Renzo Duarte','Cristina Mc','Guillermo Solano','Mauricio')
      then 'MANTENER'
    else 'BORRAR'
  end as accion
from public.deals
group by owner
order by accion, negocios desc;


-- ---------- PASO 2 · BORRADO (ejecutar solo tras revisar el PASO 1) ----------
-- Borra únicamente propietarios NO autorizados y respeta los cambios pendientes.
-- delete from public.deals
-- where owner not in ('Nicolás Aramburú','Renzo Duarte','Cristina Mc','Guillermo Solano','Mauricio')
--   and coalesce(sync_pending, false) = false;


-- ---------- PASO 3 · VERIFICACIÓN (debe listar solo los 5 autorizados) ----------
-- select owner, count(*) as negocios
-- from public.deals
-- group by owner
-- order by negocios desc;

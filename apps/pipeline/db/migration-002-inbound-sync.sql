-- ============================================================
-- Migración 002 — soporte para sincronización de ENTRADA (Pipedrive → app)
-- Pégala en: Supabase → SQL Editor → New query → Run  (es idempotente)
-- ============================================================

-- 1) Bandera para respetar cambios locales aún NO confirmados en Pipedrive.
--    El cron de entrada NO sobreescribe filas con sync_pending = true.
alter table public.deals add column if not exists sync_pending boolean not null default false;

-- 2) Índice ÚNICO por pipedrive_id (evita duplicados y habilita el "upsert").
--    Los NULL se permiten repetidos (deals locales sin Pipedrive); los no-NULL, únicos.
create unique index if not exists deals_pipedrive_uidx on public.deals (pipedrive_id);

-- 3) Permitir que la app (clave anónima) BORRE filas: cuando un negocio se cierra
--    (ganado/perdido) desaparece de la vista activa. (Piloto sin login: RLS abierto.)
drop policy if exists deals_delete_anon on public.deals;
create policy deals_delete_anon on public.deals
  for delete to anon using (true);

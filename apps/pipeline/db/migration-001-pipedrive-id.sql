-- ============================================================
-- Migración 001 — agrega el ID de Pipedrive a los negocios
-- Pégala en: Supabase → SQL Editor → New query → Run
-- (Si recién creaste la base con el schema.sql nuevo, ya tiene la columna y
--  esta migración no hace daño: es idempotente.)
-- ============================================================

alter table public.deals add column if not exists pipedrive_id bigint;
create index if not exists deals_pipedrive_idx on public.deals (pipedrive_id);

-- Cómo poblarla (ejemplos):
--   Una fila:   update public.deals set pipedrive_id = 1234 where id = 5;
--   Por título: update public.deals set pipedrive_id = 1234 where title = 'Equans - Coaching individual al liderazgo';
--
-- Solo los negocios con pipedrive_id se sincronizan con Pipedrive.
-- Los que queden en NULL se muestran en la app marcados como "sin Pipedrive".

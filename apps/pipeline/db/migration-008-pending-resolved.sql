-- ============================================================
-- Migración 008 — "resuelto por semana" de la sección Mis pendientes
-- Pégala en: Supabase → SQL Editor → New query → Run  (idempotente)
--
-- Cuando un partner marca ✓ o agrega un comentario a un negocio de los bloques
-- A/B de "Mis pendientes", ese negocio se marca como resuelto SOLO por la semana
-- actual (identificada por el lunes, hora Perú). La próxima semana reaparece si
-- sigue calificando (sigue en una de las 4 etapas activas). El bloque C NO usa
-- esta marca: se resuelve solo cuando se completan los campos.
--
-- Se accede server-side con el service_role (ignora RLS). RLS activo sin políticas.
-- ============================================================

create table if not exists public.pending_resolved (
  id          bigint generated always as identity primary key,
  partner     text   not null,
  deal_id     bigint not null,               -- id del negocio en Pipedrive
  week_start  date   not null,               -- lunes (hora Perú) de la semana
  created_at  timestamptz not null default now(),
  unique (partner, deal_id, week_start)
);

create index if not exists pending_resolved_week_idx on public.pending_resolved (week_start);

alter table public.pending_resolved enable row level security;
-- Sin políticas: solo el service_role (server-side) lee/escribe.

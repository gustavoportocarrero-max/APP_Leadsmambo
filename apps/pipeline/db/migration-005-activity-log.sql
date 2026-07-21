-- ============================================================
-- Migración 005 — registro de actividad de la app (para el reporte a Slack)
-- Pégala en: Supabase → SQL Editor → New query → Run  (idempotente)
--
-- Guarda cada cambio hecho DESDE LA APP: quién (partner/correo), qué negocio,
-- qué campo, el valor nuevo y cuándo. Alimenta /api/weekly-report.
-- ============================================================

create table if not exists public.activity_log (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  actor        text    not null default '',   -- nombre del partner (o correo si admin/sin mapear)
  actor_email  text    not null default '',
  pipedrive_id bigint,                         -- id del negocio en Pipedrive (si tiene)
  org          text    not null default '',
  title        text    not null default '',
  field        text    not null default '',    -- "Etapa" | "Monto" | "Probabilidad" | ...
  new_value    text    not null default ''
);

create index if not exists activity_log_created_idx on public.activity_log (created_at desc);
create index if not exists activity_log_actor_idx   on public.activity_log (actor);

alter table public.activity_log enable row level security;

drop policy if exists activity_insert on public.activity_log;
create policy activity_insert on public.activity_log
  for insert to anon, authenticated with check (true);

drop policy if exists activity_select on public.activity_log;
create policy activity_select on public.activity_log
  for select to anon, authenticated using (true);

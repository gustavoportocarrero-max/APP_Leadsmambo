-- ============================================================
-- Migración 007 — idempotencia de los correos de recordatorio
-- Pégala en: Supabase → SQL Editor → New query → Run  (idempotente)
--
-- Evita el envío duplicado (p. ej. si cron-job.org reintenta la ejecución o el
-- endpoint se llama dos veces). El endpoint weekly-email "reserva" cada
-- (partner, semana, modo) ANTES de enviar; si la reserva ya existe, no reenvía.
-- Si el envío falla, la reserva se borra para poder reintentar.
--
-- Solo se accede server-side con el service_role (que ignora RLS). RLS queda
-- activo SIN políticas → nadie con la clave anónima puede leer quién recibió correo.
-- ============================================================

create table if not exists public.weekly_email_sent (
  id          bigint generated always as identity primary key,
  partner     text not null,
  week_start  date not null,                 -- lunes (hora Perú) de la semana
  mode        text not null,                 -- 'all' | 'pending'
  created_at  timestamptz not null default now(),
  unique (partner, week_start, mode)
);

create index if not exists weekly_email_sent_week_idx on public.weekly_email_sent (week_start);

alter table public.weekly_email_sent enable row level security;
-- Sin políticas: solo el service_role (server-side) puede leer/escribir.

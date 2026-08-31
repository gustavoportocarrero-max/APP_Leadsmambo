-- ============================================================
-- Migración 009 — atención de LEADS CALIENTES (flujo aparte del checklist semanal)
-- Pégala en: Supabase → SQL Editor → New query → Run  (idempotente)
--
-- Registro INDEPENDIENTE de weekly_review. Guarda, por semana (lunes, hora Perú)
-- y por partner, si dio clic en "Sin novedades" (acked) desde el correo de leads
-- calientes. La OTRA forma de cumplir —editar uno de sus leads calientes— NO se
-- guarda aquí: se deduce de activity_log al armar el reporte del jueves.
--
-- Solo se accede server-side con el service_role (ignora RLS). RLS activo sin
-- políticas → nadie con la clave anónima lee/escribe esta tabla.
-- ============================================================

create table if not exists public.hot_leads_review (
  id          bigint generated always as identity primary key,
  partner     text   not null,
  week_start  date   not null,               -- lunes (hora Perú) de la semana
  acked       boolean not null default true, -- dio "Sin novedades"
  acked_at    timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  unique (partner, week_start)
);

create index if not exists hot_leads_review_week_idx on public.hot_leads_review (week_start);

alter table public.hot_leads_review enable row level security;
-- Sin políticas: solo el service_role (server-side) lee/escribe.

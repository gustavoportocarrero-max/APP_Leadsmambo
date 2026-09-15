-- ============================================================
-- Migración 010 — estado de alertas del sistema (anti-spam)
-- Pégala en: Supabase → SQL Editor → New query → Run  (idempotente)
--
-- Recuerda si ya se envió una alerta para no repetirla en cada ejecución. Hoy la
-- usa la alerta de "token de Pipedrive caído" (key = 'pipedrive_token'):
--   state='down' → ya se alertó; no se vuelve a alertar hasta que se recupere.
--   state='ok'   → sano; si vuelve a fallar, se alerta de nuevo.
--
-- Solo se accede server-side con el service_role (ignora RLS). RLS activo sin políticas.
-- ============================================================

create table if not exists public.system_alerts (
  key               text primary key,                 -- p.ej. 'pipedrive_token'
  state             text not null default 'ok',       -- 'ok' | 'down'
  last_alert_at     timestamptz,                       -- último aviso de caída
  last_recovery_at  timestamptz,                       -- última recuperación
  updated_at        timestamptz not null default now()
);

alter table public.system_alerts enable row level security;
-- Sin políticas: solo el service_role (server-side) lee/escribe.

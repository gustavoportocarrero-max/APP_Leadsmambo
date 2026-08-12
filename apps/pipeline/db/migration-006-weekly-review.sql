-- ============================================================
-- Migración 006 — confirmación semanal de revisión ("Terminé de revisar")
-- Pégala en: Supabase → SQL Editor → New query → Run  (idempotente)
--
-- Guarda, por partner y por semana (lunes de esa semana, hora Perú), si el
-- partner CONFIRMÓ que revisó/editó su base ("Sí"), cuántas veces dijo "No",
-- y su última respuesta. Alimenta los recordatorios (correos martes/miércoles)
-- y el reporte de estado a Slack (miércoles 6pm).
--
-- El estado se "reinicia" cada lunes porque la semana se identifica por
-- week_start (fecha del lunes): una fila distinta por (partner, semana).
-- ============================================================

create table if not exists public.weekly_review (
  id           bigint generated always as identity primary key,
  partner      text    not null,                 -- nombre del partner (coincide con owner)
  actor_email  text    not null default '',
  week_start   date    not null,                 -- lunes (hora Perú) de la semana
  confirmed    boolean not null default false,   -- alguna vez dijo "Sí" esta semana
  no_count     int     not null default 0,       -- veces que dijo "No" esta semana
  last_status  text    not null default '',      -- 'si' | 'no' (última respuesta)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (partner, week_start)
);

create index if not exists weekly_review_week_idx on public.weekly_review (week_start);

alter table public.weekly_review enable row level security;

-- Piloto: acceso a anon + authenticated (igual que deals/activity_log).
drop policy if exists weekly_review_select on public.weekly_review;
create policy weekly_review_select on public.weekly_review
  for select to anon, authenticated using (true);

drop policy if exists weekly_review_insert on public.weekly_review;
create policy weekly_review_insert on public.weekly_review
  for insert to anon, authenticated with check (true);

drop policy if exists weekly_review_update on public.weekly_review;
create policy weekly_review_update on public.weekly_review
  for update to anon, authenticated using (true) with check (true);

-- Registro atómico de una respuesta ("si"/"no"). Hace upsert por (partner, semana):
--   - "si": marca confirmed=true (no se revierte aunque luego diga "no").
--   - "no": incrementa no_count.
-- Devuelve el estado resultante (no_count, confirmed, last_status) para que la app
-- decida si mostrar la advertencia del 2º "No".
create or replace function public.record_weekly_review(
  p_partner text, p_email text, p_week date, p_answer text
) returns table (no_count int, confirmed boolean, last_status text)
language plpgsql
as $$
begin
  insert into public.weekly_review (partner, actor_email, week_start, confirmed, no_count, last_status)
  values (
    p_partner, coalesce(p_email, ''), p_week,
    (p_answer = 'si'),
    (case when p_answer = 'no' then 1 else 0 end),
    p_answer
  )
  on conflict (partner, week_start) do update set
    actor_email = coalesce(excluded.actor_email, public.weekly_review.actor_email),
    confirmed   = public.weekly_review.confirmed or (p_answer = 'si'),
    no_count    = public.weekly_review.no_count + (case when p_answer = 'no' then 1 else 0 end),
    last_status = p_answer,
    updated_at  = now();

  return query
    select wr.no_count, wr.confirmed, wr.last_status
    from public.weekly_review wr
    where wr.partner = p_partner and wr.week_start = p_week;
end;
$$;

grant execute on function public.record_weekly_review(text, text, date, text) to anon, authenticated;

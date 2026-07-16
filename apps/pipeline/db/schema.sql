-- ============================================================
-- mambo · Pipeline — esquema de la base en Supabase
-- Pega TODO esto en: Supabase → SQL Editor → New query → Run
-- ============================================================

-- 1) Tabla de negocios -------------------------------------------------
create table if not exists public.deals (
  id           bigint generated always as identity primary key,
  pipedrive_id bigint,                                     -- id del negocio en Pipedrive (NULL = no sincronizable)
  sync_pending boolean not null default false,             -- cambio local sin confirmar en Pipedrive (el cron no lo pisa)
  -- editables desde la app
  stage        text    not null default 'target',         -- target|primera|contacto|propuesta|cierre|nurturing
  amount       numeric not null default 0,                 -- valor del negocio (US$)
  prob         numeric,                                    -- 0–100, NULL = sin definir
  comment      text    not null default '',
  status       text    not null default 'activo',          -- 'activo' | 'perdido'
  loss_reason  text    not null default '',                -- obligatorio si status='perdido'
  -- identidad / solo lectura (contexto)
  org          text    not null default '',
  title        text    not null default '',
  owner        text    not null default '',                -- propietario (partner)
  vertical     text    not null default '',
  client_type  text    not null default '',
  industry     text    not null default '',
  source       text    not null default '',                -- fuente lead
  sale_type    text    not null default '',                -- tipo de venta
  close_date   date,                                       -- NULL = sin fecha
  -- auditoría
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Índices útiles para filtrar
create index if not exists deals_owner_idx on public.deals (owner);
create index if not exists deals_stage_idx on public.deals (stage);
-- único por pipedrive_id (anti-duplicados + habilita upsert); NULLs repetidos permitidos
create unique index if not exists deals_pipedrive_uidx on public.deals (pipedrive_id);

-- 2) updated_at automático en cada UPDATE ------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_deals_updated_at on public.deals;
create trigger trg_deals_updated_at
  before update on public.deals
  for each row
  execute function public.set_updated_at();

-- 3) Row Level Security ------------------------------------------------
-- OJO: piloto SIN login. Estas políticas permiten leer/escribir a cualquiera
-- con la clave anónima. La regla "cada partner solo edita lo suyo" es del lado
-- de la app (no seguridad real). Si luego quieres seguridad real, se agrega
-- login y se endurecen estas políticas.
alter table public.deals enable row level security;

-- Piloto: acceso abierto a anon + authenticated (el control real es el login por
-- dominio en la app). Si luego quieres endurecer, restringe a authenticated.
drop policy if exists deals_select_anon on public.deals;
create policy deals_select_anon on public.deals
  for select to anon, authenticated using (true);

drop policy if exists deals_update_anon on public.deals;
create policy deals_update_anon on public.deals
  for update to anon, authenticated using (true) with check (true);

drop policy if exists deals_insert_anon on public.deals;
create policy deals_insert_anon on public.deals
  for insert to anon, authenticated with check (true);

drop policy if exists deals_delete_anon on public.deals;
create policy deals_delete_anon on public.deals
  for delete to anon, authenticated using (true);

-- 4) Realtime: emitir cambios de la tabla ------------------------------
alter table public.deals replica identity full;
alter publication supabase_realtime add table public.deals;

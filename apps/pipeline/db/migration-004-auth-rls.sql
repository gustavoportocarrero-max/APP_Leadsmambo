-- ============================================================
-- Migración 004 — RLS para usuarios autenticados (login con Google)
-- Pégala en: Supabase → SQL Editor → New query → Run  (idempotente)
--
-- IMPORTANTE: córrela ANTES de publicar el login. Al iniciar sesión, la app deja
-- de consultar como rol "anon" y pasa a "authenticated"; si las políticas siguen
-- siendo solo para "anon", la app dejaría de leer/escribir tras el login.
-- Aquí extendemos las políticas a anon + authenticated (piloto sin restricción por
-- fila; el control de acceso real es el login por dominio en la app).
-- ============================================================

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

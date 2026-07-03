-- ============================================================
-- Migración 003 — columna para "Tipo de Venta"
-- Pégala en: Supabase → SQL Editor → New query → Run (idempotente)
-- Los demás campos descriptivos (vertical, industry, client_type, source) ya existen.
-- ============================================================

alter table public.deals add column if not exists sale_type text not null default '';

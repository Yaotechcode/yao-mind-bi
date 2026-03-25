-- =============================================================================
-- Yao Mind — Migration 003: Formula Versions
-- Run against your Supabase project via the SQL Editor or Supabase CLI.
--
-- Adds:
--   - formula_versions table (immutable per-change snapshots of formula defs)
--   - version_number + is_latest columns to formula_registry
--
-- Versions are INSERT-only via RLS; the server role updates is_current when
-- a new version is created. Users cannot UPDATE or DELETE version history.
-- =============================================================================

-- =============================================================================
-- 1. formula_versions — immutable audit log of formula definition changes
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.formula_versions (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id        uuid        NOT NULL REFERENCES public.firms(id) ON DELETE CASCADE,
  formula_id     text        NOT NULL,
  version_number integer     NOT NULL,

  -- Only one row per (firm_id, formula_id) should have is_current = true.
  -- Managed by the server: INSERT new version, UPDATE old to is_current = false.
  is_current     boolean     NOT NULL DEFAULT true,

  -- Full snapshot of the formula/snippet definition at this version
  name           text        NOT NULL,
  description    text,
  category       text,
  formula_type   text        NOT NULL,
  entity_type    text        NOT NULL,
  result_type    text        NOT NULL,
  definition     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  active_variant text,
  variants       jsonb,
  modifiers      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  depends_on     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  display_config jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- Change metadata
  change_summary text,
  changed_by     uuid        REFERENCES public.users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (firm_id, formula_id, version_number)
);

-- =============================================================================
-- 2. Extend formula_registry with version tracking columns
-- =============================================================================

ALTER TABLE public.formula_registry
  ADD COLUMN IF NOT EXISTS version_number integer DEFAULT 1,
  ADD COLUMN IF NOT EXISTS is_latest      boolean DEFAULT true;

-- =============================================================================
-- 3. Indexes
-- =============================================================================

-- Fastest path to the current version (most common query)
CREATE INDEX IF NOT EXISTS formula_versions_current_idx
  ON public.formula_versions(firm_id, formula_id, is_current)
  WHERE is_current = true;

-- Version history in descending order
CREATE INDEX IF NOT EXISTS formula_versions_history_idx
  ON public.formula_versions(firm_id, formula_id, version_number DESC);

-- Audit queries ordered by creation date
CREATE INDEX IF NOT EXISTS formula_versions_firm_created_idx
  ON public.formula_versions(firm_id, created_at DESC);

-- =============================================================================
-- 4. Row Level Security
-- =============================================================================

ALTER TABLE public.formula_versions ENABLE ROW LEVEL SECURITY;

-- Any firm member can read their firm's version history
CREATE POLICY "formula_versions_select" ON public.formula_versions
  FOR SELECT USING (firm_id = get_user_firm_id());

-- Any authenticated firm member can create versions (server does this via service role)
CREATE POLICY "formula_versions_insert" ON public.formula_versions
  FOR INSERT WITH CHECK (firm_id = get_user_firm_id());

-- No UPDATE policy — version rows are immutable via RLS.
-- The service role bypasses RLS to update is_current when a new version is inserted.

-- No DELETE policy — version history must never be deleted via the API.

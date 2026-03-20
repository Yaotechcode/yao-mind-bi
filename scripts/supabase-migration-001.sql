-- =============================================================================
-- Yao Mind — Migration 001: Core Schema + RLS
-- Run against your Supabase project via the SQL Editor or Supabase CLI.
-- =============================================================================

-- Helper function: get the firm_id for the currently authenticated user
CREATE OR REPLACE FUNCTION get_user_firm_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT firm_id FROM public.users WHERE id = auth.uid() LIMIT 1;
$$;

-- Helper function: get the role for the currently authenticated user
CREATE OR REPLACE FUNCTION get_user_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT role FROM public.users WHERE id = auth.uid() LIMIT 1;
$$;

-- =============================================================================
-- 1. firms
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.firms (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text        NOT NULL,
  created_at           timestamptz DEFAULT now(),
  financial_year_end   text        DEFAULT '31-March',
  currency             text        DEFAULT 'GBP'
);

ALTER TABLE public.firms ENABLE ROW LEVEL SECURITY;

CREATE POLICY "firms_select" ON public.firms
  FOR SELECT
  USING (
    id IN (SELECT firm_id FROM public.users WHERE id = auth.uid())
  );

CREATE POLICY "firms_update_owner_only" ON public.firms
  FOR UPDATE
  USING (get_user_firm_id() = id AND get_user_role() = 'owner');

-- =============================================================================
-- 2. users (extends auth.users)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.users (
  id           uuid  PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  firm_id      uuid  REFERENCES public.firms(id) ON DELETE CASCADE,
  email        text  NOT NULL,
  display_name text,
  role         text  NOT NULL CHECK (role IN ('owner', 'admin', 'partner', 'department_head', 'fee_earner', 'viewer')),
  department   text,
  is_active    boolean     DEFAULT true,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS users_firm_id_idx ON public.users(firm_id);

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_select" ON public.users
  FOR SELECT
  USING (firm_id = get_user_firm_id());

CREATE POLICY "users_insert" ON public.users
  FOR INSERT
  WITH CHECK (firm_id = get_user_firm_id());

CREATE POLICY "users_update" ON public.users
  FOR UPDATE
  USING (firm_id = get_user_firm_id());

CREATE POLICY "users_delete_admin" ON public.users
  FOR DELETE
  USING (firm_id = get_user_firm_id() AND get_user_role() IN ('owner', 'admin'));

-- =============================================================================
-- 3. firm_config
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.firm_config (
  id                    uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id               uuid    REFERENCES public.firms(id) ON DELETE CASCADE UNIQUE,
  working_time_defaults jsonb   NOT NULL DEFAULT '{}'::jsonb,
  salaried_config       jsonb   NOT NULL DEFAULT '{}'::jsonb,
  fee_share_config      jsonb   NOT NULL DEFAULT '{}'::jsonb,
  revenue_attribution   text    NOT NULL DEFAULT 'responsible_lawyer',
  data_trust_model      jsonb   NOT NULL DEFAULT '{}'::jsonb,
  display_preferences   jsonb   NOT NULL DEFAULT '{}'::jsonb,
  export_settings       jsonb   NOT NULL DEFAULT '{}'::jsonb,
  rag_thresholds        jsonb   NOT NULL DEFAULT '{}'::jsonb,
  overhead_config       jsonb   NOT NULL DEFAULT '{}'::jsonb,
  scorecard_weights     jsonb   NOT NULL DEFAULT '{}'::jsonb,
  updated_at            timestamptz DEFAULT now(),
  updated_by            uuid    REFERENCES public.users(id)
);

CREATE INDEX IF NOT EXISTS firm_config_firm_id_idx ON public.firm_config(firm_id);

ALTER TABLE public.firm_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "firm_config_select" ON public.firm_config
  FOR SELECT USING (firm_id = get_user_firm_id());

CREATE POLICY "firm_config_insert" ON public.firm_config
  FOR INSERT WITH CHECK (firm_id = get_user_firm_id());

CREATE POLICY "firm_config_update" ON public.firm_config
  FOR UPDATE USING (firm_id = get_user_firm_id());

CREATE POLICY "firm_config_delete_admin" ON public.firm_config
  FOR DELETE USING (firm_id = get_user_firm_id() AND get_user_role() IN ('owner', 'admin'));

-- =============================================================================
-- 4. entity_registry
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.entity_registry (
  id            uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id       uuid    REFERENCES public.firms(id) ON DELETE CASCADE,
  entity_key    text    NOT NULL,
  is_built_in   boolean DEFAULT false,
  label         text    NOT NULL,
  plural_label  text    NOT NULL,
  icon          text,
  description   text,
  fields        jsonb   NOT NULL DEFAULT '[]'::jsonb,
  relationships jsonb   NOT NULL DEFAULT '[]'::jsonb,
  data_source   text,
  derived_from  jsonb,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now(),
  UNIQUE (firm_id, entity_key)
);

CREATE INDEX IF NOT EXISTS entity_registry_firm_entity_idx ON public.entity_registry(firm_id, entity_key);

ALTER TABLE public.entity_registry ENABLE ROW LEVEL SECURITY;

CREATE POLICY "entity_registry_select" ON public.entity_registry
  FOR SELECT USING (firm_id = get_user_firm_id());

CREATE POLICY "entity_registry_insert" ON public.entity_registry
  FOR INSERT WITH CHECK (firm_id = get_user_firm_id());

CREATE POLICY "entity_registry_update" ON public.entity_registry
  FOR UPDATE USING (firm_id = get_user_firm_id());

CREATE POLICY "entity_registry_delete_admin" ON public.entity_registry
  FOR DELETE USING (firm_id = get_user_firm_id() AND get_user_role() IN ('owner', 'admin'));

-- =============================================================================
-- 5. custom_fields
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.custom_fields (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id        uuid REFERENCES public.firms(id) ON DELETE CASCADE,
  entity_key     text NOT NULL,
  field_key      text NOT NULL,
  label          text NOT NULL,
  data_type      text NOT NULL CHECK (data_type IN ('text', 'number', 'currency', 'percentage', 'date', 'boolean', 'select', 'reference')),
  select_options jsonb,
  default_value  text,
  description    text,
  source         text CHECK (source IN ('csv_mapping', 'manual', 'derived')),
  display_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now(),
  UNIQUE (firm_id, entity_key, field_key)
);

CREATE INDEX IF NOT EXISTS custom_fields_firm_entity_idx ON public.custom_fields(firm_id, entity_key);

ALTER TABLE public.custom_fields ENABLE ROW LEVEL SECURITY;

CREATE POLICY "custom_fields_select" ON public.custom_fields
  FOR SELECT USING (firm_id = get_user_firm_id());

CREATE POLICY "custom_fields_insert" ON public.custom_fields
  FOR INSERT WITH CHECK (firm_id = get_user_firm_id());

CREATE POLICY "custom_fields_update" ON public.custom_fields
  FOR UPDATE USING (firm_id = get_user_firm_id());

CREATE POLICY "custom_fields_delete_admin" ON public.custom_fields
  FOR DELETE USING (firm_id = get_user_firm_id() AND get_user_role() IN ('owner', 'admin'));

-- =============================================================================
-- 6. formula_registry
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.formula_registry (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id        uuid REFERENCES public.firms(id) ON DELETE CASCADE,
  formula_id     text NOT NULL,
  name           text NOT NULL,
  description    text,
  category       text,
  formula_type   text NOT NULL CHECK (formula_type IN ('built_in', 'custom', 'snippet')),
  entity_type    text NOT NULL,
  result_type    text NOT NULL CHECK (result_type IN ('currency', 'percentage', 'hours', 'days', 'number', 'ratio', 'boolean')),
  definition     jsonb NOT NULL DEFAULT '{}'::jsonb,
  active_variant text,
  variants       jsonb,
  modifiers      jsonb NOT NULL DEFAULT '[]'::jsonb,
  depends_on     jsonb NOT NULL DEFAULT '[]'::jsonb,
  display_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active      boolean DEFAULT true,
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now(),
  UNIQUE (firm_id, formula_id)
);

CREATE INDEX IF NOT EXISTS formula_registry_firm_id_idx ON public.formula_registry(firm_id, formula_id);
CREATE INDEX IF NOT EXISTS formula_registry_firm_type_idx ON public.formula_registry(firm_id, formula_type);

ALTER TABLE public.formula_registry ENABLE ROW LEVEL SECURITY;

CREATE POLICY "formula_registry_select" ON public.formula_registry
  FOR SELECT USING (firm_id = get_user_firm_id());

CREATE POLICY "formula_registry_insert" ON public.formula_registry
  FOR INSERT WITH CHECK (firm_id = get_user_firm_id());

CREATE POLICY "formula_registry_update" ON public.formula_registry
  FOR UPDATE USING (firm_id = get_user_firm_id());

CREATE POLICY "formula_registry_delete_admin" ON public.formula_registry
  FOR DELETE USING (firm_id = get_user_firm_id() AND get_user_role() IN ('owner', 'admin'));

-- =============================================================================
-- 7. column_mapping_templates
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.column_mapping_templates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id        uuid REFERENCES public.firms(id) ON DELETE CASCADE,
  name           text NOT NULL,
  file_type      text NOT NULL,
  mappings       jsonb NOT NULL,
  type_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz DEFAULT now()
);

ALTER TABLE public.column_mapping_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "column_mapping_templates_select" ON public.column_mapping_templates
  FOR SELECT USING (firm_id = get_user_firm_id());

CREATE POLICY "column_mapping_templates_insert" ON public.column_mapping_templates
  FOR INSERT WITH CHECK (firm_id = get_user_firm_id());

CREATE POLICY "column_mapping_templates_update" ON public.column_mapping_templates
  FOR UPDATE USING (firm_id = get_user_firm_id());

CREATE POLICY "column_mapping_templates_delete_admin" ON public.column_mapping_templates
  FOR DELETE USING (firm_id = get_user_firm_id() AND get_user_role() IN ('owner', 'admin'));

-- =============================================================================
-- 8. fee_earner_overrides
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.fee_earner_overrides (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id        uuid REFERENCES public.firms(id) ON DELETE CASCADE,
  fee_earner_id  text NOT NULL,
  overrides      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now(),
  updated_by     uuid REFERENCES public.users(id),
  UNIQUE (firm_id, fee_earner_id)
);

CREATE INDEX IF NOT EXISTS fee_earner_overrides_firm_earner_idx ON public.fee_earner_overrides(firm_id, fee_earner_id);

ALTER TABLE public.fee_earner_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "fee_earner_overrides_select" ON public.fee_earner_overrides
  FOR SELECT USING (firm_id = get_user_firm_id());

CREATE POLICY "fee_earner_overrides_insert" ON public.fee_earner_overrides
  FOR INSERT WITH CHECK (firm_id = get_user_firm_id());

CREATE POLICY "fee_earner_overrides_update" ON public.fee_earner_overrides
  FOR UPDATE USING (firm_id = get_user_firm_id());

CREATE POLICY "fee_earner_overrides_delete_admin" ON public.fee_earner_overrides
  FOR DELETE USING (firm_id = get_user_firm_id() AND get_user_role() IN ('owner', 'admin'));

-- =============================================================================
-- 9. audit_log (immutable — no UPDATE or DELETE policies)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id     uuid REFERENCES public.firms(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES public.users(id),
  action      text NOT NULL,
  entity_type text,
  entity_id   text,
  path        text,
  old_value   jsonb,
  new_value   jsonb,
  description text,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_firm_created_idx ON public.audit_log(firm_id, created_at DESC);

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "audit_log_select" ON public.audit_log
  FOR SELECT USING (firm_id = get_user_firm_id());

CREATE POLICY "audit_log_insert" ON public.audit_log
  FOR INSERT WITH CHECK (firm_id = get_user_firm_id());

-- No UPDATE or DELETE — audit log is append-only.

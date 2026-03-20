-- =============================================================================
-- Yao Mind — Migration 002: Database Helper Functions
-- Run AFTER migration-001.
-- =============================================================================

-- =============================================================================
-- create_firm_with_owner
-- Creates a firm, links the calling user as owner, creates default firm_config.
-- Returns the new firm_id.
-- Usage: SELECT create_firm_with_owner('Acme Law', auth.uid(), 'user@firm.com', 'Alice');
-- =============================================================================

CREATE OR REPLACE FUNCTION public.create_firm_with_owner(
  firm_name   text,
  user_id     uuid,
  user_email  text,
  user_name   text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_firm_id uuid;
BEGIN
  -- Create the firm
  INSERT INTO public.firms (name)
  VALUES (firm_name)
  RETURNING id INTO v_firm_id;

  -- Create the owner user record
  INSERT INTO public.users (id, firm_id, email, display_name, role)
  VALUES (user_id, v_firm_id, user_email, user_name, 'owner');

  -- Create default firm_config
  INSERT INTO public.firm_config (
    firm_id,
    working_time_defaults,
    salaried_config,
    fee_share_config,
    revenue_attribution,
    data_trust_model,
    display_preferences,
    export_settings,
    rag_thresholds,
    overhead_config,
    scorecard_weights,
    updated_by
  )
  VALUES (
    v_firm_id,
    -- working_time_defaults
    jsonb_build_object(
      'hoursPerDay', 7.5,
      'daysPerWeek', 5,
      'targetBillableHoursPerDay', 6.0,
      'weekStartDay', 'monday'
    ),
    -- salaried_config
    jsonb_build_object(
      'useHourlyRate', false,
      'targetUtilisation', 0.75,
      'overtimeThresholdHours', 7.5
    ),
    -- fee_share_config
    jsonb_build_object(
      'defaultFeeSharePct', 0.0,
      'includeVatInBilling', false
    ),
    -- revenue_attribution
    'responsible_lawyer',
    -- data_trust_model
    jsonb_build_object(
      'allowOverrides', true,
      'requireJustification', false
    ),
    -- display_preferences
    jsonb_build_object(
      'dateFormat', 'DD/MM/YYYY',
      'currency', 'GBP',
      'decimalPlaces', 2,
      'thousandsSeparator', ','
    ),
    -- export_settings
    jsonb_build_object(
      'defaultFormat', 'csv',
      'includeHeaders', true
    ),
    -- rag_thresholds (default set — can be overridden per firm)
    jsonb_build_object(
      'utilisation', jsonb_build_object(
        'green', jsonb_build_object('min', 0.75),
        'amber', jsonb_build_object('min', 0.60, 'max', 0.75),
        'red',   jsonb_build_object('max', 0.60)
      ),
      'realisationRate', jsonb_build_object(
        'green', jsonb_build_object('min', 0.85),
        'amber', jsonb_build_object('min', 0.70, 'max', 0.85),
        'red',   jsonb_build_object('max', 0.70)
      ),
      'writeOffRate', jsonb_build_object(
        'green', jsonb_build_object('max', 0.05),
        'amber', jsonb_build_object('min', 0.05, 'max', 0.10),
        'red',   jsonb_build_object('min', 0.10)
      ),
      'debtorDays', jsonb_build_object(
        'green', jsonb_build_object('max', 30),
        'amber', jsonb_build_object('min', 30, 'max', 60),
        'red',   jsonb_build_object('min', 60)
      )
    ),
    -- overhead_config
    jsonb_build_object(
      'enabled', false,
      'annualOverhead', 0,
      'allocationMethod', 'per_fee_earner'
    ),
    -- scorecard_weights
    jsonb_build_object(
      'utilisation', 0.30,
      'realisationRate', 0.25,
      'writeOffRate', 0.20,
      'debtorDays', 0.15,
      'clientSatisfaction', 0.10
    ),
    -- updated_by
    user_id
  );

  -- Write audit log entry
  INSERT INTO public.audit_log (firm_id, user_id, action, entity_type, entity_id, description)
  VALUES (v_firm_id, user_id, 'create', 'firm', v_firm_id::text, 'Firm created with owner account');

  RETURN v_firm_id;
END;
$$;

-- =============================================================================
-- invite_user_to_firm
-- Creates a user record for an invited user.
-- The actual Supabase Auth signup must be triggered separately via the client
-- (e.g., supabase.auth.signUp or the Supabase dashboard invite flow).
-- Returns the new user record id.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.invite_user_to_firm(
  p_firm_id    uuid,
  p_email      text,
  p_role       text,
  p_department text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_auth_user_id  uuid;
  v_caller_role   text;
  v_caller_firm   uuid;
BEGIN
  -- Authorisation check: caller must be owner or admin of the target firm
  SELECT role, firm_id INTO v_caller_role, v_caller_firm
  FROM public.users
  WHERE id = auth.uid();

  IF v_caller_firm <> p_firm_id THEN
    RAISE EXCEPTION 'Not authorised: caller does not belong to this firm';
  END IF;

  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Not authorised: only owners and admins can invite users';
  END IF;

  -- Validate role value
  IF p_role NOT IN ('owner', 'admin', 'partner', 'department_head', 'fee_earner', 'viewer') THEN
    RAISE EXCEPTION 'Invalid role: %', p_role;
  END IF;

  -- Look up the auth user by email (they may already exist from a prior invite)
  SELECT id INTO v_auth_user_id
  FROM auth.users
  WHERE email = p_email
  LIMIT 1;

  IF v_auth_user_id IS NULL THEN
    RAISE EXCEPTION 'Auth user not found for email %. Trigger Supabase Auth invite first.', p_email;
  END IF;

  -- Upsert user record
  INSERT INTO public.users (id, firm_id, email, role, department)
  VALUES (v_auth_user_id, p_firm_id, p_email, p_role, p_department)
  ON CONFLICT (id) DO UPDATE
    SET firm_id    = EXCLUDED.firm_id,
        role       = EXCLUDED.role,
        department = EXCLUDED.department,
        updated_at = now();

  -- Audit
  INSERT INTO public.audit_log (firm_id, user_id, action, entity_type, entity_id, description)
  VALUES (
    p_firm_id,
    auth.uid(),
    'create',
    'user',
    v_auth_user_id::text,
    format('User %s invited with role %s', p_email, p_role)
  );

  RETURN v_auth_user_id;
END;
$$;

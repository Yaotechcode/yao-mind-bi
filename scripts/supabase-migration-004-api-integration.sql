-- Migration 004: API Integration Tables
-- Creates: yao_api_credentials, kpi_snapshots, pull_status

-- ============================================================
-- TABLE: yao_api_credentials
-- Stores AES-256 encrypted Yao API credentials per firm.
-- Credentials are never cached or stored in env vars.
-- ============================================================

CREATE TABLE IF NOT EXISTS yao_api_credentials (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id           uuid        NOT NULL REFERENCES firms(id) ON DELETE CASCADE UNIQUE,
  encrypted_email   text        NOT NULL,
  encrypted_password text       NOT NULL,
  encryption_key_id text        NOT NULL,
  last_verified_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- No DELETE permitted — rotate credentials via UPDATE only.
ALTER TABLE yao_api_credentials ENABLE ROW LEVEL SECURITY;

-- Firm owner and admin can INSERT their own firm's row.
CREATE POLICY "yao_api_credentials_insert" ON yao_api_credentials
  FOR INSERT
  TO authenticated
  WITH CHECK (
    firm_id = get_user_firm_id()
    AND EXISTS (
      SELECT 1 FROM users
      WHERE id = auth.uid()
      AND role IN ('owner', 'admin')
    )
  );

-- Firm owner and admin can UPDATE their own firm's row.
CREATE POLICY "yao_api_credentials_update" ON yao_api_credentials
  FOR UPDATE
  TO authenticated
  USING (
    firm_id = get_user_firm_id()
    AND EXISTS (
      SELECT 1 FROM users
      WHERE id = auth.uid()
      AND role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    firm_id = get_user_firm_id()
    AND EXISTS (
      SELECT 1 FROM users
      WHERE id = auth.uid()
      AND role IN ('owner', 'admin')
    )
  );

-- Firm owner and admin can SELECT their own firm's row.
CREATE POLICY "yao_api_credentials_select" ON yao_api_credentials
  FOR SELECT
  TO authenticated
  USING (firm_id = get_user_firm_id());

-- Trigger to keep updated_at current.
CREATE OR REPLACE FUNCTION update_yao_api_credentials_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER yao_api_credentials_updated_at
  BEFORE UPDATE ON yao_api_credentials
  FOR EACH ROW EXECUTE FUNCTION update_yao_api_credentials_updated_at();


-- ============================================================
-- TABLE: kpi_snapshots
-- Pre-computed KPI results. The sole data source for all
-- dashboards. Written by Netlify Background Function only.
-- ============================================================

CREATE TABLE IF NOT EXISTS kpi_snapshots (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id      uuid        NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  pulled_at    timestamptz NOT NULL,
  entity_type  text        NOT NULL
    CHECK (entity_type IN ('feeEarner','matter','invoice','disbursement','department','client','firm')),
  entity_id    text        NOT NULL,
  entity_name  text        NOT NULL,
  kpi_key      text        NOT NULL,
  kpi_value    numeric,
  rag_status   text
    CHECK (rag_status IN ('green','amber','red','neutral')),
  period       text        NOT NULL DEFAULT 'current',
  display_value text
);

ALTER TABLE kpi_snapshots ENABLE ROW LEVEL SECURITY;

-- Firm users can SELECT their own firm's rows.
CREATE POLICY "kpi_snapshots_select" ON kpi_snapshots
  FOR SELECT
  TO authenticated
  USING (firm_id = get_user_firm_id());

-- INSERT/UPDATE/DELETE: service role only (Netlify Background Function).
-- No policy for INSERT/UPDATE/DELETE means authenticated users cannot write.
-- Service role bypasses RLS by default.

-- Primary dashboard query pattern: fetch all KPIs for an entity type in a period.
CREATE INDEX IF NOT EXISTS kpi_snapshots_firm_type_period
  ON kpi_snapshots (firm_id, entity_type, period);

-- Entity detail queries: fetch all KPIs for a specific entity.
CREATE INDEX IF NOT EXISTS kpi_snapshots_firm_entity_kpi
  ON kpi_snapshots (firm_id, entity_id, kpi_key);

-- Latest snapshot queries: find when data was last pulled.
CREATE INDEX IF NOT EXISTS kpi_snapshots_firm_pulled_at
  ON kpi_snapshots (firm_id, pulled_at DESC);


-- ============================================================
-- TABLE: pull_status
-- Tracks the state of each firm's data pull.
-- One row per firm. Written by Netlify Background Function.
-- ============================================================

CREATE TABLE IF NOT EXISTS pull_status (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id           uuid        NOT NULL REFERENCES firms(id) ON DELETE CASCADE UNIQUE,
  status            text        NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle','running','complete','failed')),
  started_at        timestamptz,
  completed_at      timestamptz,
  pulled_at         timestamptz,
  current_stage     text,
  records_fetched   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  records_processed integer     NOT NULL DEFAULT 0,
  error             text
);

ALTER TABLE pull_status ENABLE ROW LEVEL SECURITY;

-- Firm users can SELECT their own firm's row.
CREATE POLICY "pull_status_select" ON pull_status
  FOR SELECT
  TO authenticated
  USING (firm_id = get_user_firm_id());

-- INSERT/UPDATE/DELETE: service role only.

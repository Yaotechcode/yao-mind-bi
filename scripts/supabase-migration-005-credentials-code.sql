-- Migration 005: Add encrypted_code column to yao_api_credentials
-- Each firm has its own Yao API MFA code; store it encrypted alongside email/password.

ALTER TABLE yao_api_credentials ADD COLUMN IF NOT EXISTS encrypted_code text;

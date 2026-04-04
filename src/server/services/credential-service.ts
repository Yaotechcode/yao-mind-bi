/**
 * credential-service.ts
 *
 * AES-256-GCM encrypted storage and retrieval of Yao API credentials.
 * Credentials are stored per-firm in the yao_api_credentials table.
 *
 * Rules:
 *  - Encryption key comes from YAO_CREDENTIAL_ENCRYPTION_KEY (32-byte hex string)
 *  - Each value is encrypted with a fresh random IV — never reuse an IV
 *  - Decrypted values are never logged
 *  - Tokens are never cached — always re-authenticate at pull time
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { getServerClient } from '../lib/supabase.js';

// =============================================================================
// Types
// =============================================================================

interface EncryptedBlob {
  iv: string;        // base64, 12 bytes
  authTag: string;   // base64, 16 bytes
  ciphertext: string; // base64
}

const ALGORITHM = 'aes-256-gcm' as const;
const KEY_ENCODING = 'hex' as const;
const ENCODING = 'base64' as const;
const KEY_BYTES = 32;

// =============================================================================
// Key management
// =============================================================================

function getEncryptionKey(): Buffer {
  const hex = process.env['YAO_CREDENTIAL_ENCRYPTION_KEY'];
  if (!hex) {
    throw new Error(
      'YAO_CREDENTIAL_ENCRYPTION_KEY is not set. ' +
        'Generate one with: openssl rand -hex 32',
    );
  }
  const buf = Buffer.from(hex, KEY_ENCODING);
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `YAO_CREDENTIAL_ENCRYPTION_KEY must be a ${KEY_BYTES * 2}-character hex string ` +
        `(got ${hex.length} characters)`,
    );
  }
  return buf;
}

// =============================================================================
// Encryption helpers
// =============================================================================

function encrypt(plaintext: string, key: Buffer): EncryptedBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString(ENCODING),
    authTag: authTag.toString(ENCODING),
    ciphertext: ciphertext.toString(ENCODING),
  };
}

function decrypt(blob: EncryptedBlob, key: Buffer): string {
  const iv = Buffer.from(blob.iv, ENCODING);
  const authTag = Buffer.from(blob.authTag, ENCODING);
  const ciphertext = Buffer.from(blob.ciphertext, ENCODING);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

function serializeBlob(blob: EncryptedBlob): string {
  return Buffer.from(JSON.stringify(blob)).toString(ENCODING);
}

function deserializeBlob(encoded: string): EncryptedBlob {
  return JSON.parse(Buffer.from(encoded, ENCODING).toString('utf8')) as EncryptedBlob;
}

// =============================================================================
// Audit helper
// =============================================================================

async function writeAuditLog(
  firmId: string,
  userId: string | null,
  action: string,
  description: string,
): Promise<void> {
  const db = getServerClient();
  await db.from('audit_log').insert({
    firm_id: firmId,
    user_id: userId,
    action,
    entity_type: 'yao_api_credentials',
    entity_id: firmId,
    description,
    created_at: new Date().toISOString(),
  });
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Encrypts and upserts Yao API credentials for a firm.
 * Logs action to audit_log without recording credential values.
 */
export async function storeCredentials(
  firmId: string,
  email: string,
  password: string,
  userId?: string,
): Promise<void> {
  const key = getEncryptionKey();
  const encryptedEmail = serializeBlob(encrypt(email, key));
  const encryptedPassword = serializeBlob(encrypt(password, key));
  const keyId = 'v1'; // increment when rotating the encryption key

  const db = getServerClient();
  const { error } = await db.from('yao_api_credentials').upsert(
    {
      firm_id: firmId,
      encrypted_email: encryptedEmail,
      encrypted_password: encryptedPassword,
      encryption_key_id: keyId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'firm_id' },
  );

  if (error) {
    throw new Error(`storeCredentials failed for firm ${firmId}: ${error.message}`);
  }

  await writeAuditLog(
    firmId,
    userId ?? null,
    'credentials_updated',
    'Yao API credentials updated',
  );
}

/**
 * Retrieves and decrypts Yao API credentials for a firm.
 * Never logs decrypted values.
 *
 * @throws if no credentials are stored for the firm
 */
export async function getCredentials(
  firmId: string,
): Promise<{ email: string; password: string }> {
  const db = getServerClient();
  const { data, error } = await db
    .from('yao_api_credentials')
    .select('encrypted_email, encrypted_password')
    .eq('firm_id', firmId)
    .single();

  if (error || !data) {
    throw new Error(
      `No API credentials found for firm ${firmId}. ` +
        'Store credentials via POST /api/yao-credentials first.',
    );
  }

  const row = data as Record<string, unknown>;
  const key = getEncryptionKey();

  const email = decrypt(deserializeBlob(row['encrypted_email'] as string), key);
  const password = decrypt(deserializeBlob(row['encrypted_password'] as string), key);

  return { email, password };
}

/**
 * Verifies that stored credentials can authenticate against the Yao API.
 * Updates last_verified_at on success. Logs outcome to audit_log.
 * Does not throw — returns true/false.
 */
export async function verifyCredentials(firmId: string): Promise<boolean> {
  let email: string;
  let password: string;

  try {
    ({ email, password } = await getCredentials(firmId));
  } catch {
    return false;
  }

  const baseUrl = process.env['YAO_API_BASE_URL'] ?? 'https://api.yao.legal';

  try {
    const response = await fetch(`${baseUrl}/attorneys/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    const valid = response.ok;

    if (valid) {
      const db = getServerClient();
      await db
        .from('yao_api_credentials')
        .update({ last_verified_at: new Date().toISOString() })
        .eq('firm_id', firmId);
    }

    await writeAuditLog(
      firmId,
      null,
      'credentials_verified',
      valid ? 'Yao API credentials verified successfully' : 'Yao API credential verification failed',
    );

    return valid;
  } catch {
    await writeAuditLog(
      firmId,
      null,
      'credentials_verified',
      'Yao API credential verification failed — network or API error',
    );
    return false;
  }
}

/**
 * Deletes stored credentials for a firm and logs the action.
 */
export async function deleteCredentials(firmId: string, userId: string): Promise<void> {
  const db = getServerClient();
  const { error } = await db
    .from('yao_api_credentials')
    .delete()
    .eq('firm_id', firmId);

  if (error) {
    throw new Error(`deleteCredentials failed for firm ${firmId}: ${error.message}`);
  }

  await writeAuditLog(firmId, userId, 'credentials_deleted', 'Yao API credentials deleted');
}

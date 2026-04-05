import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load .env.local manually
const envPath = resolve(process.cwd(), '.env.local');
const envContent = readFileSync(envPath, 'utf-8');
envContent.split('\n').forEach(line => {
  const [key, value] = line.split('=');
  if (key && value) {
    process.env[key.trim()] = value.trim();
  }
});

const FIRM_ID = '63937b4d-b4ab-4a86-b6ae-28135306c757';
const EMAIL = 'colin.secomb@lewisdenley.com';
const PASSWORD = 'Yao@421';
const ENCRYPTION_KEY = process.env.YAO_CREDENTIAL_ENCRYPTION_KEY;

console.log('Encryption key:', ENCRYPTION_KEY);
console.log('Key length:', ENCRYPTION_KEY?.length);

if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64) {
  console.error('❌ Invalid YAO_CREDENTIAL_ENCRYPTION_KEY (must be 64 hex chars)');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function encrypt(text: string, key: string): string {
  const iv = crypto.randomBytes(16);
  const keyBuffer = Buffer.from(key, 'hex');
  const cipher = crypto.createCipheriv('aes-256-cbc', keyBuffer, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

async function main() {
  console.log('Encrypting credentials...');
  const encryptedEmail = encrypt(EMAIL, ENCRYPTION_KEY);
  const encryptedPassword = encrypt(PASSWORD, ENCRYPTION_KEY);

  console.log('Storing in Supabase...');
  const { data, error } = await supabase
    .from('yao_api_credentials')
    .upsert({
      firm_id: FIRM_ID,
      encrypted_email: encryptedEmail,
      encrypted_password: encryptedPassword,
      encryption_key_id: 'default',
      last_verified_at: new Date().toISOString(),
    }, { onConflict: 'firm_id' });

  if (error) {
    console.error('❌ Failed to store credentials:', error.message);
    process.exit(1);
  }

  console.log('✅ Credentials stored for Lewis Denley');
}

main();

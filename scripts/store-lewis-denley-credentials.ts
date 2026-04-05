/**
 * Stores Lewis Denley Yao API credentials using the production
 * credential-service (AES-256-GCM, same as the pull will use).
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load .env.local
const envContent = readFileSync(resolve(process.cwd(), '.env.local'), 'utf-8');
envContent.split('\n').forEach(line => {
  const eqIdx = line.indexOf('=');
  if (eqIdx > 0) {
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();
    if (key && !process.env[key]) process.env[key] = value;
  }
});

import { storeCredentials } from '../src/server/services/credential-service.js';

const FIRM_ID = '63937b4d-b4ab-4a86-b6ae-28135306c757';
const EMAIL    = 'colin.secomb@lewisdenley.com';
const PASSWORD = 'Yao@421';
const CODE     = Number(process.env['YAO_API_CODE'] ?? '0');

async function main() {
  console.log('Storing credentials via credential-service (AES-256-GCM)...');
  await storeCredentials(FIRM_ID, EMAIL, PASSWORD, CODE);
  console.log('✅ Credentials stored for Lewis Denley');
}

main().catch(err => {
  console.error('❌', err.message);
  process.exit(1);
});

import { readFileSync } from 'fs';
import { resolve } from 'path';

const envContent = readFileSync(resolve(process.cwd(), '.env.local'), 'utf-8');
envContent.split('\n').forEach(line => {
  const eqIdx = line.indexOf('=');
  if (eqIdx > 0) {
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim().replace(/^'|'$/g, '');
    if (key && !process.env[key]) process.env[key] = value;
  }
});

import { storeCredentials } from '../src/server/services/credential-service.js';

const FIRM_ID = '63937b4d-b4ab-4a86-b6ae-28135306c757';
const EMAIL    = 'colin.secomb@lewisdenley.com';
const PASSWORD = 'Yao@421';
const CODE     = 101;

async function main() {
  console.log('Storing credentials with code via credential-service (AES-256-GCM)...');
  await storeCredentials(FIRM_ID, EMAIL, PASSWORD, CODE);
  console.log('✅ Credentials stored for Lewis Denley (including code=101)');
}

main().catch(err => {
  console.error('❌', err.message);
  process.exit(1);
});

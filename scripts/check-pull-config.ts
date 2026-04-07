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

import { getFirmConfig } from '../src/server/services/config-service.js';

async function main() {
  const FIRM = '63937b4d-b4ab-4a86-b6ae-28135306c757';
  const config = await getFirmConfig(FIRM);
  console.log('dataPullLookbackMonths:', config.dataPullLookbackMonths);
  console.log('calculationWindowMonths:', (config.billingMethodConfig as Record<string, unknown> | undefined)?.['calculationWindowMonths'] ?? 'not set');
  console.log('Full config keys:', Object.keys(config));
}
main().catch(console.error).finally(() => process.exit(0));

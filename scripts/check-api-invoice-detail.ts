// Find the correct API client path first
import { readdirSync } from 'fs';
import { join } from 'path';

function findFiles(dir: string, pattern: RegExp): string[] {
  const results: string[] = [];
  try {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, f.name);
      if (f.isDirectory()) results.push(...findFiles(full, pattern));
      else if (pattern.test(f.name)) results.push(full);
    }
  } catch {}
  return results;
}

const files = findFiles('/mnt/c/Projects/yao-mind-bi/src/server', /api|client|adapter/i);
console.log('API-related files:');
files.forEach(f => console.log(' ', f));

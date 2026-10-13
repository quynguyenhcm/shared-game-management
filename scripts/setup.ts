import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLACEHOLDER = '<generated-by-setup>';

export type SetupResult = 'created' | 'exists';

/**
 * Copies `.env.example` to `.env` when `.env` is missing and swaps the ENCRYPTION_KEYS placeholder for a
 * random dev key (id `dev1`, 32 random bytes, base64). Idempotent: an existing `.env` is never touched.
 */
export function runSetup(rootDir: string): SetupResult {
  const target = join(rootDir, '.env');
  if (existsSync(target)) return 'exists';
  copyFileSync(join(rootDir, '.env.example'), target);
  const key = `dev1:${randomBytes(32).toString('base64')}`;
  const content = readFileSync(target, 'utf8').replace(
    /^ENCRYPTION_KEYS=.*$/m,
    () => `ENCRYPTION_KEYS=${key}`,
  );
  if (content.includes(PLACEHOLDER)) {
    throw new Error('setup: unreplaced placeholder left in .env');
  }
  writeFileSync(target, content, { mode: 0o600 });
  return 'created';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const rootDir = resolve(fileURLToPath(import.meta.url), '..', '..');
  const result = runSetup(rootDir);
  process.stdout.write(
    result === 'created'
      ? 'setup: created .env from .env.example with a generated dev ENCRYPTION_KEYS\n'
      : 'setup: .env already exists, left unchanged\n',
  );
}

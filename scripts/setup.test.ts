import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseEncryptionKeys } from '../apps/api/src/lib/config/config.ts';
import { runSetup } from './setup.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sgm-setup-'));
  writeFileSync(
    join(dir, '.env.example'),
    'DATABASE_URL=postgres://x\nENCRYPTION_KEYS=<generated-by-setup>\nENCRYPTION_ACTIVE_KEY_ID=dev1\n',
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('scripts/setup', () => {
  it('creates .env with a valid generated key and never overwrites an existing .env', () => {
    expect(runSetup(dir)).toBe('created');
    const env = readFileSync(join(dir, '.env'), 'utf8');
    const value = /^ENCRYPTION_KEYS=(.*)$/m.exec(env)?.[1] ?? '';
    expect(env).not.toContain('<generated-by-setup>');
    expect(parseEncryptionKeys(value).issues).toEqual([]);

    expect(runSetup(dir)).toBe('exists');
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(env);

    writeFileSync(join(dir, '.env'), 'CUSTOM=1\n');
    expect(runSetup(dir)).toBe('exists');
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('CUSTOM=1\n');
  });
});

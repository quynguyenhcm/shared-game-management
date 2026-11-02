import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('lib/akahu boundary', () => {
  it('imports nothing from modules/* and has no live client or adapter yet (Phase 4)', () => {
    const directory = fileURLToPath(new URL('.', import.meta.url));
    const files = readdirSync(directory).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    expect(files).toEqual(
      expect.arrayContaining(['gateway.ts', 'status.ts', 'fake-adapter.ts', 'key-cache.ts']),
    );
    expect(files).not.toContain('client.ts');
    expect(files).not.toContain('akahu-adapter.ts');
    for (const file of files) {
      const source = readFileSync(`${directory}${file}`, 'utf8');
      expect(source, file).not.toMatch(/from\s+['"][^'"]*modules\//);
    }
  });
});

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { generateOpenApiYaml } from './openapi.ts';

describe('OpenAPI document', () => {
  it('matches the committed apps/api/openapi.yaml (run `pnpm run openapi` after changing routes)', async () => {
    const committed = await readFile(new URL('../openapi.yaml', import.meta.url), 'utf8');
    expect(await generateOpenApiYaml()).toBe(committed);
  });
});

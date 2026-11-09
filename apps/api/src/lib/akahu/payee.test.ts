import { describe, expect, it } from 'vitest';
import { normalisePayeeName } from './payee.ts';

describe('normalisePayeeName (charset rules to be re-read from the live docs at the Phase 4 gate)', () => {
  it('keeps a plain name, strips diacritics and unsupported characters, collapses whitespace', () => {
    expect(normalisePayeeName('Quiet Badminton Club')).toEqual({
      ok: true,
      name: 'Quiet Badminton Club',
    });
    expect(normalisePayeeName('  Māori  Rugby Club  <script>  ')).toEqual({
      ok: true,
      name: 'Maori Rugby Club script',
    });
    expect(normalisePayeeName("O'Brien & Sons (Wellington) - Smash")).toEqual({
      ok: true,
      name: "O'Brien & Sons (Wellington) - Smash",
    });
  });

  it('truncates to 70 characters without a trailing space and refuses names that cannot be used', () => {
    const long = normalisePayeeName(`${'ab '.repeat(40)}`);
    if (!long.ok) throw new Error('expected a usable name');
    expect(long.name.length).toBeLessThanOrEqual(70);
    expect(long.name).toBe(long.name.trim());
    for (const unusable of ['', ' ', 'a', '!!!', '日本語', '--']) {
      expect(normalisePayeeName(unusable), unusable).toEqual({
        ok: false,
        reason: 'payee_unusable',
      });
    }
  });
});

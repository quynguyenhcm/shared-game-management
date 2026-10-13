import { describe, expect, it } from 'vitest';
import { toMoneyString } from './money.ts';
import { moneyInputSchema, moneyStringSchema } from './zod.ts';

describe('money wire schemas', () => {
  it('moneyStringSchema accepts only strict 2-dp strings (responses)', () => {
    expect(moneyStringSchema.parse('17.50')).toBe('17.50');
    for (const bad of ['17.5', 17.5, '1e3', null, '17.505']) {
      expect(moneyStringSchema.safeParse(bad).success, String(bad)).toBe(false);
    }
  });

  it('moneyInputSchema parses 0-2 dp strings to Money and rejects JSON numbers and bad strings', () => {
    const parsed = moneyInputSchema.parse('17.5');
    expect(toMoneyString(parsed)).toBe('17.50');
    expect(moneyInputSchema.safeParse(17.5).success).toBe(false);
    const bad = moneyInputSchema.safeParse('17.505');
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0]?.message).toContain('TOO_MANY_DECIMALS');
    expect(moneyInputSchema.safeParse('abc').success).toBe(false);
  });
});

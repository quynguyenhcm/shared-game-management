/** Wire contracts for money: JSON strings, never JSON numbers (algorithm doc §Q6). */
import { z } from 'zod';
import {
  MoneyValidationError,
  isMoneyString,
  parseMoney,
  type Money,
  type MoneyString,
} from './money.ts';

/** Responses: strict 2-dp canonical string, e.g. "17.50". */
export const moneyStringSchema: z.ZodType<MoneyString> = z.custom<MoneyString>(
  isMoneyString,
  'must be a money string with exactly 2 decimal places, e.g. "17.50"',
);

/** Requests: 0-2 dp decimal string parsed to `Money`. */
export const moneyInputSchema: z.ZodType<Money, string> = z.string().transform((value, ctx) => {
  try {
    return parseMoney(value);
  } catch (error) {
    const detail = error instanceof MoneyValidationError ? `${error.code}: ${error.message}` : '';
    ctx.issues.push({ code: 'custom', message: `invalid money (${detail})`, input: value });
    return z.NEVER;
  }
});

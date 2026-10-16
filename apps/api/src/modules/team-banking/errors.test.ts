import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/http/errors.ts';
import { mapBankingDbError } from './errors.ts';

const pgError = (code: string, constraint?: string): Error =>
  Object.assign(new Error('db'), { code, ...(constraint === undefined ? {} : { constraint }) });

describe('mapBankingDbError (R4 backstop)', () => {
  it('turns the removal trigger violation into 409 banking_in_use, keyed on SQLSTATE and constraint', () => {
    const mapped = mapBankingDbError(pgError('23514', 'teams_banking_in_use'));
    expect(mapped).toBeInstanceOf(AppError);
    expect((mapped as AppError).code).toBe('banking_in_use');
    expect((mapped as AppError).status).toBe(409);
  });

  it('leaves every other error unchanged, including the same constraint under another SQLSTATE', () => {
    const others = [
      pgError('23514', 'teams_gst_number_format'),
      pgError('23505', 'teams_banking_in_use'),
      new Error('plain'),
    ];
    for (const error of others) expect(mapBankingDbError(error)).toBe(error);
    expect(mapBankingDbError('not an error')).toBe('not an error');
  });
});

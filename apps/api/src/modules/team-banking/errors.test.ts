import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/http/errors.ts';
import { mapBankingDbError, mapPublishGateDbError } from './errors.ts';

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

describe('mapPublishGateDbError (publish trigger backstop)', () => {
  it('turns the publish trigger violation into 409 payout_not_configured and keeps the cause', () => {
    const original = pgError('23514', 'game_sessions_paid_requires_payout');
    const mapped = mapPublishGateDbError(original);
    expect(mapped).toBeInstanceOf(AppError);
    expect((mapped as AppError).code).toBe('payout_not_configured');
    expect((mapped as AppError).status).toBe(409);
    expect((mapped as AppError).cause).toBe(original);
  });

  it('keys on constraint and SQLSTATE, never on message text, and leaves everything else unchanged', () => {
    const lookalike = Object.assign(new Error('game_sessions_paid_requires_payout'), {
      code: '23514',
      constraint: 'game_sessions_instants_when_live',
    });
    const others = [
      lookalike,
      pgError('23505', 'game_sessions_paid_requires_payout'),
      pgError('23514', 'teams_banking_in_use'),
      new Error('plain'),
    ];
    for (const error of others) expect(mapPublishGateDbError(error)).toBe(error);
    expect(mapPublishGateDbError(undefined)).toBeUndefined();
  });
});

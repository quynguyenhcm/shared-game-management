/**
 * Database error mapping for the sessions module (architecture SA-7 table) and the transient/permanent
 * classification the materialiser uses to decide between retrying and failing a job (AC-ERROR-9).
 * Keyed on SQLSTATE plus `err.constraint`, never on message text.
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/http/errors.ts';
import { classifySessionError, mapSessionDbError } from './errors.ts';

const pgError = (code: string, constraint?: string): Error =>
  Object.assign(new Error('boom: secret row data'), { code, constraint });

describe('mapSessionDbError', () => {
  it('maps lifecycle and immutability guards to their 409 codes', () => {
    for (const [constraint, code] of [
      ['game_sessions_status_transition', 'session_state_conflict'],
      ['game_sessions_closed_immutable', 'session_not_editable'],
      ['session_courts_closed_immutable', 'session_not_editable'],
    ] as const) {
      const mapped = mapSessionDbError(pgError('23000', constraint));
      expect(mapped, constraint).toBeInstanceOf(AppError);
      expect((mapped as AppError).code).toBe(code);
      expect((mapped as AppError).status).toBe(409);
    }
  });

  it('maps content CHECKs to a 422 on the field, never echoing the database message', () => {
    const deadline = mapSessionDbError(
      pgError('23514', 'game_sessions_deadline_before_start'),
    ) as AppError;
    expect(deadline.code).toBe('validation_failed');
    expect(deadline.fieldErrors).toEqual({
      cancellationDeadline: ['The deadline must be before the first court starts.'],
    });
    expect(deadline.message).not.toContain('secret');

    const duplicate = mapSessionDbError(
      pgError('23505', 'uq_session_courts_session_identifier'),
    ) as AppError;
    expect(duplicate.fieldErrors).toEqual({ courts: ['Court names must be different.'] });

    const noCourt = mapSessionDbError(
      pgError('23514', 'game_sessions_instants_when_live'),
    ) as AppError;
    expect(noCourt.fieldErrors).toEqual({ courts: ['Add at least one court.'] });

    const skill = mapSessionDbError(
      pgError('23514', 'game_sessions_skill_fees_when_live'),
    ) as AppError;
    expect(Object.keys(skill.fieldErrors ?? {})).toEqual([
      'feeBeginner',
      'feeIntermediate',
      'feeAdvanced',
    ]);

    const keys = mapSessionDbError(pgError('23000', 'game_sessions_keys_immutable')) as AppError;
    expect(keys.fieldErrors).toEqual({
      date: ['To move this night, cancel it and create a one-off session.'],
    });
  });

  it('maps the fee-raise backstop and the payout backstop, and leaves everything else alone', () => {
    const locked = mapSessionDbError(
      pgError('23514', 'game_sessions_fee_raise_locked'),
    ) as AppError;
    expect(locked.code).toBe('session_fee_locked');
    const payout = mapSessionDbError(
      pgError('23514', 'game_sessions_paid_requires_payout'),
    ) as AppError;
    expect(payout.code).toBe('payout_not_configured');

    const unknown = pgError('23514', 'something_else');
    expect(mapSessionDbError(unknown)).toBe(unknown);
    const plain = new Error('x');
    expect(mapSessionDbError(plain)).toBe(plain);
    expect(mapSessionDbError('text')).toBe('text');
  });
});

describe('classifySessionError', () => {
  it('treats lock conflicts, serialization failures, connection errors and unknown failures as transient', () => {
    for (const code of ['40P01', '55P03', '40001', '08006', '08003']) {
      expect(classifySessionError(pgError(code)), code).toEqual({
        transient: true,
        sqlState: code,
        errorCode: code,
      });
    }
    expect(classifySessionError(new TypeError('x'))).toEqual({
      transient: true,
      sqlState: undefined,
      errorCode: 'TypeError',
    });
    expect(classifySessionError('weird')).toEqual({
      transient: true,
      sqlState: undefined,
      errorCode: 'unknown',
    });
  });

  it('treats constraint and data errors as permanent', () => {
    for (const code of ['23514', '23505', '22007', '23000']) {
      expect(classifySessionError(pgError(code)).transient, code).toBe(false);
    }
  });
});

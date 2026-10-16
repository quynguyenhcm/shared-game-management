import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/http/errors.ts';
import { SkillLevelStaleError, mapSkillLevelsDbError } from './errors.ts';

const pgError = (code: string, constraint?: string): Error =>
  Object.assign(new Error('db said no'), { code, constraint });

describe('mapSkillLevelsDbError (keyed on SQLSTATE + constraint, never message text)', () => {
  it('maps a lock timeout to a retryable 503 and the approved-only backstop to a state conflict', () => {
    const timeout = mapSkillLevelsDbError(pgError('55P03'));
    expect(timeout).toBeInstanceOf(AppError);
    expect(timeout).toMatchObject({ code: 'service_unavailable', status: 503 });
    expect(
      mapSkillLevelsDbError(pgError('23514', 'team_members_auto_enroll_approved_only')),
    ).toMatchObject({ code: 'membership_state_conflict', status: 409 });
  });

  it('leaves everything else unchanged', () => {
    const other = pgError('23514', 'team_members_override_stamps_paired');
    expect(mapSkillLevelsDbError(other)).toBe(other);
    expect(mapSkillLevelsDbError('not an error')).toBe('not an error');
    const domain = new AppError('forbidden');
    expect(mapSkillLevelsDbError(domain)).toBe(domain);
  });
});

describe('SkillLevelStaleError', () => {
  it('is a 409 skill_level_stale AppError that carries the current member', () => {
    const member = { userId: 'u' } as never;
    const error = new SkillLevelStaleError(member);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'skill_level_stale', status: 409, member });
  });
});

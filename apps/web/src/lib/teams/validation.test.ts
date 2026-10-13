import { describe, expect, it } from 'vitest';
import { validateCreateTeam, validateJoinRequest } from './validation.ts';

const KEY = '2f6c1c1e-7a64-4c0e-9d61-3c1f0c1f0a11';
const valid = {
  name: 'Rosedale Badminton',
  description: 'Wednesday nights',
  visibility: 'PUBLIC',
  skillLevel: 'INTERMEDIATE',
  idempotencyKey: KEY,
};

describe('validateCreateTeam (AC-ERROR-1: the same shared messages as the API)', () => {
  it('accepts a complete form, with or without a description', () => {
    expect(validateCreateTeam(valid)).toEqual({});
    expect(validateCreateTeam({ ...valid, description: '' })).toEqual({});
    expect(validateCreateTeam({ ...valid, description: undefined })).toEqual({});
  });

  it('names a blank or whitespace-only team name', () => {
    expect(validateCreateTeam({ ...valid, name: '' }).name).toEqual(['Enter a team name.']);
    expect(validateCreateTeam({ ...valid, name: '   ' }).name).toEqual(['Enter a team name.']);
    expect(validateCreateTeam({ ...valid, name: undefined }).name).toEqual(['Enter a team name.']);
  });

  it('enforces 100 and 1000 character limits after trimming, with no maxlength involved', () => {
    expect(validateCreateTeam({ ...valid, name: 'a'.repeat(100) })).toEqual({});
    expect(validateCreateTeam({ ...valid, name: 'a'.repeat(101) }).name).toEqual([
      'Use 100 characters or fewer.',
    ]);
    expect(validateCreateTeam({ ...valid, description: 'a'.repeat(1001) }).description).toEqual([
      'Use 1000 characters or fewer.',
    ]);
  });

  it('requires a visibility and a skill level, treating an empty string as not chosen', () => {
    const errors = validateCreateTeam({ ...valid, visibility: '', skillLevel: undefined });
    expect(errors.visibility).toEqual(['Choose who can find your team.']);
    expect(errors.skillLevel).toEqual(['Select your skill level to continue.']);
  });

  it('reports every problem at once', () => {
    const errors = validateCreateTeam({ name: '', idempotencyKey: KEY });
    expect(Object.keys(errors).sort()).toEqual(['name', 'skillLevel', 'visibility']);
  });
});

describe('validateJoinRequest (AC-ERROR-2)', () => {
  it('blocks a missing skill level with the exact message', () => {
    expect(validateJoinRequest({})).toEqual({
      skillLevel: ['Select your skill level to continue.'],
    });
    expect(validateJoinRequest({ skillLevel: '' }).skillLevel).toBeDefined();
    expect(validateJoinRequest({ skillLevel: 'EXPERT' }).skillLevel).toBeDefined();
  });

  it('accepts each of the three levels', () => {
    for (const skillLevel of ['BEGINNER', 'INTERMEDIATE', 'ADVANCED']) {
      expect(validateJoinRequest({ skillLevel })).toEqual({});
    }
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildRegisterBody,
  fieldErrorsFromApi,
  guestFieldNames,
  validateGuests,
} from './validation.ts';

const ANA = { sex: 'FEMALE', skillLevel: 'INTERMEDIATE', displayName: ' Ana ' } as const;

describe('validateGuests: the same messages as the API, with the guest number (AC-ERROR-5)', () => {
  it('a missing sex and a missing skill level name the guest and keep the field id', () => {
    expect(
      validateGuests([
        { sex: '', skillLevel: '', displayName: '' },
        { sex: 'MALE', skillLevel: '', displayName: '' },
      ]),
    ).toEqual({
      guest1Sex: ["Choose Guest 1's sex."],
      guest1Skill: ["Choose Guest 1's skill level."],
      guest2Skill: ["Choose Guest 2's skill level."],
    });
  });

  it('a name over 100 characters (no maxlength attribute, so the message is reachable)', () => {
    expect(
      validateGuests([{ sex: 'MALE', skillLevel: 'BEGINNER', displayName: 'x'.repeat(101) }]),
    ).toEqual({
      guest1Name: ['Use 100 characters or fewer.'],
    });
    expect(
      validateGuests([{ sex: 'MALE', skillLevel: 'BEGINNER', displayName: 'x'.repeat(100) }]),
    ).toEqual({});
  });

  it('no guests, no errors', () => {
    expect(validateGuests([])).toEqual({});
  });
});

describe('buildRegisterBody: the strict API body', () => {
  it('sends only guests, trims the name and omits an empty one', () => {
    expect(
      buildRegisterBody([ANA, { sex: 'MALE', skillLevel: 'BEGINNER', displayName: '   ' }]),
    ).toEqual({
      guests: [
        { sex: 'FEMALE', skillLevel: 'INTERMEDIATE', displayName: 'Ana' },
        { sex: 'MALE', skillLevel: 'BEGINNER' },
      ],
    });
    expect(buildRegisterBody([])).toEqual({ guests: [] });
  });
});

describe('fieldErrorsFromApi maps guests.{i}.* keys to the form field ids', () => {
  it('keys and copy', () => {
    expect(
      fieldErrorsFromApi({
        'guests.0.sex': ['Choose a sex.'],
        'guests.1.skillLevel': ['Choose a skill level.'],
        'guests.1.displayName': ['Use 100 characters or fewer.'],
      }),
    ).toEqual({
      guest1Sex: ["Choose Guest 1's sex."],
      guest2Skill: ["Choose Guest 2's skill level."],
      guest2Name: ['Use 100 characters or fewer.'],
    });
  });
  it('a key the form has no field for lands on the first guest, never dropped', () => {
    expect(fieldErrorsFromApi({ guests: ['You can bring up to 2 guests.'] })).toEqual({
      guests: ['You can bring up to 2 guests.'],
    });
  });
  it('guestFieldNames lists the ids in form order for the error summary', () => {
    expect(guestFieldNames(2)).toEqual([
      'guest1Sex',
      'guest1Skill',
      'guest1Name',
      'guest2Sex',
      'guest2Skill',
      'guest2Name',
    ]);
  });
});

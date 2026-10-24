import { GUEST_NAME_MAX_LENGTH, type SessionRegisterRequest } from '@sgm/shared';
import type { FieldErrors } from '../auth/validation.ts';

/** What the form holds for one guest: radio values (empty until chosen) and the typed name. */
export interface GuestValues {
  sex: string;
  skillLevel: string;
  displayName: string;
}

export const guestSexError = (n: number): string => `Choose Guest ${n}'s sex.`;
export const guestSkillError = (n: number): string => `Choose Guest ${n}'s skill level.`;
export const GUEST_NAME_ERROR = `Use ${GUEST_NAME_MAX_LENGTH} characters or fewer.`;

/** The form-field names of guest `n` (1-based), in form order. They are also the element ids after `field-`. */
export function guestFieldNames(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    return [`guest${n}Sex`, `guest${n}Skill`, `guest${n}Name`];
  }).flat();
}

/** Client-side guest checks, the same rules and words as the API (AC-ERROR-5); the API stays the authority. */
export function validateGuests(guests: readonly GuestValues[]): FieldErrors {
  const errors: FieldErrors = {};
  guests.forEach((guest, index) => {
    const n = index + 1;
    if (guest.sex === '') errors[`guest${n}Sex`] = [guestSexError(n)];
    if (guest.skillLevel === '') errors[`guest${n}Skill`] = [guestSkillError(n)];
    if (guest.displayName.trim().length > GUEST_NAME_MAX_LENGTH) {
      errors[`guest${n}Name`] = [GUEST_NAME_ERROR];
    }
  });
  return errors;
}

/**
 * The strict request body. The server owns everything else (`status`, `queuePosition`, `userId`, `teamId`). The name is trimmed
 * and an empty one is left out; sex and level are passed as typed for the API to validate, so a hand-edited form is a 422.
 */
export function buildRegisterBody(guests: readonly GuestValues[]): SessionRegisterRequest {
  return {
    guests: guests.map((guest) => {
      const name = guest.displayName.trim();
      return {
        sex: guest.sex,
        skillLevel: guest.skillLevel,
        ...(name === '' ? {} : { displayName: name }),
      };
    }) as SessionRegisterRequest['guests'],
  };
}

const API_KEY = /^guests\.(\d+)\.(sex|skillLevel|displayName)$/;

/** `guests.{i}.sex` and friends become the form's `guest{n}Sex` ids with the guest number in the words; other keys pass through. */
export function fieldErrorsFromApi(apiErrors: Record<string, string[]>): FieldErrors {
  const errors: FieldErrors = {};
  for (const [key, messages] of Object.entries(apiErrors)) {
    const match = API_KEY.exec(key);
    if (match === null) {
      errors[key] = messages;
      continue;
    }
    const n = Number(match[1]) + 1;
    switch (match[2]) {
      case 'sex':
        errors[`guest${n}Sex`] = [guestSexError(n)];
        break;
      case 'skillLevel':
        errors[`guest${n}Skill`] = [guestSkillError(n)];
        break;
      default:
        errors[`guest${n}Name`] = [messages[0] ?? GUEST_NAME_ERROR];
    }
  }
  return errors;
}

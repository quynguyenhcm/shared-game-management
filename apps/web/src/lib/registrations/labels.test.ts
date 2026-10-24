import { describe, expect, it } from 'vitest';
import {
  AUTO_ENROL_LABEL,
  closedText,
  deadlineLine,
  debtMessage,
  feeLine,
  feeListLines,
  formatWhen,
  groupLine,
  guestLine,
  partyOptionHint,
  passedOverLine,
  registerResultMessage,
  seatsLine,
  withdrawPrompt,
  withdrawResultMessage,
  withdrawnText,
} from './labels.ts';

describe('seatsLine renders session.seatsLeft, publicCapacity and waitlistLength as the server sent them', () => {
  it('free places', () => {
    expect(seatsLine({ seatsLeft: 3, publicCapacity: 10, waitlistLength: 0 })).toBe(
      '3 of 10 places left',
    );
  });
  it('free places and a waiting group (UI/UX amendment 4)', () => {
    expect(seatsLine({ seatsLeft: 1, publicCapacity: 10, waitlistLength: 2 })).toBe(
      '1 of 10 places left · 2 on the waitlist',
    );
  });
  it('full, including an empty waitlist (AC-HAPPY-2)', () => {
    expect(seatsLine({ seatsLeft: 0, publicCapacity: 10, waitlistLength: 3 })).toBe(
      'Full · 3 on the waitlist',
    );
    expect(seatsLine({ seatsLeft: 0, publicCapacity: 10, waitlistLength: 0 })).toBe(
      'Full · 0 on the waitlist',
    );
  });
});

describe('dates are shown in Pacific/Auckland from the server instant', () => {
  it('formatWhen: day, date and 12-hour clock', () => {
    // 2026-11-03T19:00Z is 8:00 am on Wed 4 Nov (NZDT, UTC+13)
    expect(formatWhen('2026-11-03T19:00:00.000Z')).toBe('Wed 4 Nov, 8:00 am');
    expect(formatWhen('2026-11-01T19:00:00.000Z')).toBe('Mon 2 Nov, 8:00 am');
  });
  it('deadlineLine: before and after, nothing without a deadline', () => {
    expect(deadlineLine('2026-11-01T19:00:00.000Z', false)).toBe(
      'Free cancellation until Mon 2 Nov, 8:00 am.',
    );
    expect(deadlineLine('2026-11-01T19:00:00.000Z', true)).toBe(
      'The free cancellation deadline has passed.',
    );
    expect(deadlineLine(null, false)).toBeNull();
  });
});

describe('feeLine renders me.unitFee / me.estimatedTotal and names the level from me.registration (R15)', () => {
  const base = {
    pricing: 'FLAT' as const,
    unitFee: '17.00',
    estimatedTotal: '17.00',
    guestCount: 0,
    registered: false,
    waitlisted: false,
    level: null,
  };
  it('FLAT before registering: the per-person fee, no total', () => {
    expect(feeLine(base)).toBe('Fee: $17.00 per person, charged after the game.');
  });
  it('BY_SKILL_LEVEL names the level the fee is based on', () => {
    expect(
      feeLine({ ...base, pricing: 'BY_SKILL_LEVEL', unitFee: '20.00', level: 'INTERMEDIATE' }),
    ).toBe('Your fee (Intermediate): $20.00, charged after the game.');
  });
  it('BY_SEX without a level: "Your fee"', () => {
    expect(feeLine({ ...base, pricing: 'BY_SEX', unitFee: '20.00' })).toBe(
      'Your fee: $20.00, charged after the game.',
    );
  });
  it('registered with guests: the server estimatedTotal for you and your guests', () => {
    expect(feeLine({ ...base, registered: true, guestCount: 2, estimatedTotal: '51.00' })).toBe(
      'Fee: $51.00 for you and 2 guests, charged after the game.',
    );
    expect(feeLine({ ...base, registered: true, guestCount: 1, estimatedTotal: '34.00' })).toBe(
      'Fee: $34.00 for you and 1 guest, charged after the game.',
    );
    expect(feeLine({ ...base, registered: true })).toBe('Fee: $17.00, charged after the game.');
  });
  it('waitlisted appends the only-if-you-get-a-place line', () => {
    expect(feeLine({ ...base, registered: true, waitlisted: true })).toBe(
      'Fee: $17.00, charged after the game. Charged only if you get a place.',
    );
  });
  it('an unpriced session says so instead of inventing a number', () => {
    expect(feeLine({ ...base, unitFee: null, estimatedTotal: null })).toBe(
      "The fee isn't set for this session yet.",
    );
  });
});

describe('feeListLines renders session.fees for BY_SEX and BY_SKILL_LEVEL only', () => {
  // wire money is a plain string at runtime; the type brands it, so the fixture is cast once
  const fees = {
    flat: null,
    male: '20.00',
    female: '17.00',
    other: '18.00',
    beginner: '15.00',
    intermediate: '17.00',
    advanced: '20.00',
  } as unknown as Parameters<typeof feeListLines>[1];
  it('is null for FLAT', () => {
    expect(feeListLines('FLAT', fees)).toBeNull();
  });
  it('lists every sex fee', () => {
    expect(feeListLines('BY_SEX', fees)).toEqual({
      intro: 'Fees depend on sex. Guests are charged by their own sex.',
      rows: ['Male: $20.00', 'Female: $17.00', 'Other: $18.00'],
    });
  });
  it('lists every skill-level fee', () => {
    expect(feeListLines('BY_SKILL_LEVEL', fees)).toEqual({
      intro: 'Fees depend on skill level. Guests are charged by their own skill level.',
      rows: ['Beginner: $15.00', 'Intermediate: $17.00', 'Advanced: $20.00'],
    });
  });
});

describe('withdrawPrompt: early, late with or without a waiting group, solo or group (R2, R9, UI/UX table)', () => {
  const solo = { kind: 'withdraw' as const, guestCount: 0, fee: '17.00' };
  it('early', () => {
    expect(withdrawPrompt({ ...solo, late: false, waitlistLength: 0 })).toBe(
      "Withdraw from this session? You won't be charged.",
    );
    expect(withdrawPrompt({ ...solo, late: false, waitlistLength: 3, guestCount: 2 })).toBe(
      "Withdraw from this session? This withdraws your whole group (you and 2 guests). You won't be charged.",
    );
  });
  it('late, nobody waiting: never presents the fee as final (R2)', () => {
    expect(withdrawPrompt({ ...solo, late: true, waitlistLength: 0 })).toBe(
      "The free cancellation deadline has passed and no one is waiting for a place, so you'll be charged $17.00 unless someone takes your place before the game. Withdraw anyway?",
    );
  });
  it('late, a group is waiting (AC-HAPPY-5 wording)', () => {
    expect(withdrawPrompt({ ...solo, late: true, waitlistLength: 2 })).toBe(
      "The free cancellation deadline has passed. If a waitlisted player takes your place you won't be charged. Otherwise you'll be charged $17.00.",
    );
    expect(
      withdrawPrompt({ ...solo, late: true, waitlistLength: 2, guestCount: 1, fee: '34.00' }),
    ).toBe(
      "The free cancellation deadline has passed. If a waitlisted player takes your place you won't be charged. Otherwise you'll be charged $34.00 for you and 1 guest. This withdraws your whole group.",
    );
  });
  it('late with no fee on the read model names "the session fee"', () => {
    expect(withdrawPrompt({ ...solo, late: true, waitlistLength: 2, fee: null })).toContain(
      "you'll be charged the session fee.",
    );
  });
  it('leaving the waitlist is the same before and after the deadline', () => {
    const leave = {
      kind: 'leave' as const,
      guestCount: 0,
      fee: null,
      waitlistLength: 1,
    };
    const text =
      "Leave the waitlist? You won't be charged. If you change your mind you can join again, but you'll go to the back of the line.";
    expect(withdrawPrompt({ ...leave, late: false })).toBe(text);
    expect(withdrawPrompt({ ...leave, late: true })).toBe(text);
  });
});

describe('withdrawnText derives the persisted state from withdrawalKind and withdrawalFeeDue (R11)', () => {
  it.each([
    ['EARLY', false],
    ['BANNED', false],
    ['LATE', false],
  ] as const)('%s with no fee due: "You won\'t be charged."', (kind, feeDue) => {
    expect(withdrawnText({ kind, feeDue, fee: '17.00', guestCount: 0 })).toBe(
      "You withdrew from this session. You won't be charged.",
    );
  });
  it('LATE with a fee due: the R2 conditional copy with the server estimate', () => {
    expect(withdrawnText({ kind: 'LATE', feeDue: true, fee: '51.00', guestCount: 2 })).toBe(
      'You withdrew from this session after the free cancellation deadline. No one has taken your place yet, so the $51.00 fee for you and 2 guests applies unless someone takes your place before the game.',
    );
    expect(withdrawnText({ kind: 'LATE', feeDue: true, fee: '17.00', guestCount: 0 })).toBe(
      'You withdrew from this session after the free cancellation deadline. No one has taken your place yet, so the $17.00 fee applies unless someone takes your place before the game.',
    );
  });
});

describe('result messages after an action', () => {
  it('register: confirmed, waitlisted with the server rank, and the two surprises', () => {
    expect(registerResultMessage({ status: 'CONFIRMED', rank: null, intent: 'register' })).toBe(
      "You're in.",
    );
    expect(registerResultMessage({ status: 'WAITLISTED', rank: 3, intent: 'waitlist' })).toBe(
      "You're on the waitlist (#3). We'll email you if a place opens up.",
    );
    expect(registerResultMessage({ status: 'WAITLISTED', rank: 1, intent: 'register' })).toBe(
      "There weren't enough places for your whole group, so you're on the waitlist (#1). We'll email you if a place opens up.",
    );
    expect(registerResultMessage({ status: 'CONFIRMED', rank: null, intent: 'waitlist' })).toBe(
      "A place opened up, so you're in.",
    );
  });
  it('withdraw: early, replaced, nobody (with the server feeEstimate), left the waitlist', () => {
    const base = { grouped: false, feeEstimate: '17.00' };
    expect(
      withdrawResultMessage({ ...base, intent: 'withdraw', kind: 'EARLY', replacedBy: 'nobody' }),
    ).toBe("You've withdrawn. You won't be charged.");
    expect(
      withdrawResultMessage({ ...base, intent: 'withdraw', kind: 'LATE', replacedBy: 'waitlist' }),
    ).toBe(
      "You've withdrawn. A player from the waitlist took your place, so you won't be charged.",
    );
    expect(
      withdrawResultMessage({ ...base, intent: 'withdraw', kind: 'LATE', replacedBy: 'nobody' }),
    ).toBe(
      "You've withdrawn. No one could take your place yet, so the $17.00 fee applies unless someone takes your place before the game.",
    );
    expect(
      withdrawResultMessage({
        ...base,
        grouped: true,
        intent: 'withdraw',
        kind: 'LATE',
        replacedBy: 'nobody',
      }),
    ).toContain('the $17.00 fee for your group applies');
    expect(
      withdrawResultMessage({ ...base, intent: 'leave', kind: 'LATE', replacedBy: 'nobody' }),
    ).toBe("You've left the waitlist.");
  });
});

describe('small panel copy', () => {
  it('debtMessage renders me.overdueCount', () => {
    expect(debtMessage(3)).toBe(
      'You have 3 overdue payments across your teams. Pay them before registering for more sessions. If you think this is wrong, ask your team admin.',
    );
  });
  it('R17 label', () => {
    expect(AUTO_ENROL_LABEL).toBe('Added automatically (Auto Enroll)');
  });
  it('group and guest lines come from the registration the server returned', () => {
    expect(groupLine(0)).toBe('Just you');
    expect(groupLine(2)).toBe('Your group: you + 2 guests');
    expect(
      guestLine({ position: 1, displayName: 'Ana', sex: 'FEMALE', skillLevel: 'INTERMEDIATE' }),
    ).toBe('Guest 1: Ana, Female, Intermediate');
    expect(guestLine({ position: 2, displayName: null, sex: 'MALE', skillLevel: 'BEGINNER' })).toBe(
      'Guest 2: Male, Beginner',
    );
  });
  it('closed text by state', () => {
    expect(closedText({ status: 'PUBLISHED', registration: null })).toEqual([
      'Registration is closed.',
    ]);
    expect(closedText({ status: 'COMPLETED', registration: 'CONFIRMED' })).toEqual([
      'This session has finished.',
      'You were registered.',
      'Registration is closed.',
    ]);
    expect(closedText({ status: 'PUBLISHED', registration: 'WAITLISTED' })).toEqual([
      "The session has started and you didn't get a place.",
      'Registration is closed.',
    ]);
  });
  it('passed-over line says nothing numeric (no client-side position math)', () => {
    expect(passedOverLine()).toMatch(/keep your spot/);
    expect(passedOverLine()).not.toMatch(/\d/);
  });
  it('party option hint renders the server capacity', () => {
    expect(partyOptionHint(2, 3)).toBe(
      "This session has 2 public places, so a group of 3 can't register.",
    );
  });
});

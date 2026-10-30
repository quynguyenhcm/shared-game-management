import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  AFTER_DEADLINE,
  BEFORE_DEADLINE,
  SESSION_ID,
  TEAM_ID,
  readFixture,
  registrationFixture,
  upcomingFixture,
} from '../../lib/registrations/fixtures.ts';

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: () => undefined, set: () => undefined }),
  headers: () => Promise.resolve(new Headers()),
}));
vi.mock('next/navigation', () => ({
  redirect: () => undefined,
  RedirectType: { replace: 'replace' },
  useRouter: () => ({ refresh: () => undefined }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const { RegistrationPanel } = await import('./registration-panel.tsx');
const { RegisterForm } = await import('./register-form.tsx');
const { WithdrawConfirm } = await import('./withdraw-confirm.tsx');
const { PlayerSessionSummary } = await import('./player-session-summary.tsx');
const { UpcomingSessions } = await import('./upcoming-sessions.tsx');
const { NotMember } = await import('./not-member.tsx');

type Read = ReturnType<typeof readFixture>;

const panel = (data: Read, now: Date = BEFORE_DEADLINE): string =>
  renderToStaticMarkup(<RegistrationPanel teamId={TEAM_ID} data={data} now={now} />);

const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

const legends = (html: string): string[] =>
  [...html.matchAll(/<legend[^>]*>([^<]*)<\/legend>/g)].map((match) => match[1] ?? '');

const buttonTag = (html: string, label: string): string =>
  new RegExp(`<button[^>]*>${label}`).exec(html)?.[0] ?? '';

const confirmed = (overrides = {}) => registrationFixture({ status: 'CONFIRMED', ...overrides });
const waitlisted = (overrides = {}) =>
  registrationFixture({ status: 'WAITLISTED', waitlistRank: 2, ...overrides });
const active = (registration: ReturnType<typeof registrationFixture>, extra = {}) =>
  readFixture({
    me: { registration, estimatedTotal: '17.00' },
    canRegister: false,
    blockedReason: 'already_registered',
    ...extra,
  });

describe('open panel (AC-ENTRY-1): every line is a server field', () => {
  const html = panel(readFixture());

  it('renders session.seatsLeft of session.publicCapacity, me.unitFee and session.cancellationDeadline', () => {
    expect(text(html)).toContain('3 of 10 places left');
    expect(text(html)).toContain('Fee: $17.00 per person, charged after the game.');
    expect(text(html)).toContain('Free cancellation until Mon 2 Nov, 8:00 am.');
  });

  it('shows the numbers the server sent, never numbers it could derive (seatsLeft is not publicCapacity - seatsTaken)', () => {
    const odd = panel(
      readFixture({
        session: { publicCapacity: 10, seatsTaken: 7, seatsLeft: 9, waitlistLength: 4 },
      }),
    );
    expect(text(odd)).toContain('9 of 10 places left · 4 on the waitlist');
  });

  it('has the "Bringing guests?" fieldset with "Just me" preselected, a Register button, and no guest fieldsets', () => {
    expect(legends(html)).toEqual(['Bringing guests?']);
    const checked = [...html.matchAll(/<input[^>]*name="party"[^>]*>/g)]
      .map((match) => match[0])
      .filter((tag) => tag.includes('checked'));
    expect(checked).toHaveLength(1);
    expect(checked[0]).toContain('value="0"');
    expect(html).toContain('>Register<');
    expect(html).not.toContain('Guest 1');
    expect(html).toContain('<h2');
    expect(html).toContain('id="registration-heading"');
  });

  it('puts the outcome in one persistent role=status region that never contains the form', () => {
    const region = /<div[^>]*role="status"[^>]*>([\s\S]*?)<\/div>/.exec(html);
    expect(region).not.toBeNull();
    expect(region?.[1]).not.toContain('<form');
    expect(html).toContain('aria-live="polite"');
  });

  it('after the deadline but before the start, the late-registration heads-up sits above the button (AC-ERROR-2)', () => {
    const late = panel(readFixture(), AFTER_DEADLINE);
    expect(text(late)).toContain(
      'The free cancellation deadline has passed. If you withdraw later you may be charged.',
    );
    expect(late.indexOf('If you withdraw later')).toBeLessThan(late.indexOf('>Register<'));
    expect(text(html)).not.toContain('If you withdraw later');
  });
});

describe('RegisterForm: guests, no preselection, no focus jump (R11, AC-ERROR-4/5)', () => {
  const props = {
    teamId: TEAM_ID,
    sessionId: SESSION_ID,
    publicCapacity: 10,
    seatsLeft: 3,
    pricing: 'FLAT' as const,
    fees: readFixture().session.fees,
    unitFee: readFixture().me.unitFee,
  };

  it('guest fieldsets follow the party group directly, with Sex, Skill level and Name, and nothing preselected', () => {
    const html = renderToStaticMarkup(<RegisterForm {...props} initialParty={2} />);
    expect(legends(html)).toEqual([
      'Bringing guests?',
      'Guest 1',
      'Sex',
      'Skill level',
      'Guest 2',
      'Sex',
      'Skill level',
    ]);
    for (const name of ['guest1Sex', 'guest1Skill', 'guest2Sex', 'guest2Skill']) {
      const radios = [...html.matchAll(new RegExp(`<input[^>]*name="${name}"[^>]*>`, 'g'))];
      expect(radios.length, name).toBe(3);
      expect(
        radios.every((radio) => !radio[0].includes('checked')),
        name,
      ).toBe(true);
    }
    expect(html).toContain('id="field-guest1Sex"');
    expect(html).toContain('id="field-guest2Name"');
    expect(html).not.toMatch(/autofocus/i);
    expect(html).not.toContain('maxLength');
    // the party group closes before Guest 1 opens, in DOM order
    expect(html.indexOf('Bringing guests?')).toBeLessThan(html.indexOf('Guest 1'));
  });

  it('an option the group can never fit (session.publicCapacity) is natively disabled with visible hint text', () => {
    const html = renderToStaticMarkup(<RegisterForm {...props} publicCapacity={2} />);
    const option = /<input[^>]*value="2"[^>]*>/.exec(html)?.[0] ?? '';
    expect(option).toContain('disabled');
    expect(option).not.toContain('aria-disabled');
    expect(option).toContain('aria-describedby');
    expect(text(html)).toContain(
      "This session has 2 public places, so a group of 3 can't register.",
    );
    const enabled = /<input[^>]*value="1"[^>]*>/.exec(html)?.[0] ?? '';
    expect(enabled).not.toContain('disabled');
  });

  it('the button says Join waitlist, with the prediction, when the party is bigger than session.seatsLeft (server stays authoritative)', () => {
    const full = renderToStaticMarkup(<RegisterForm {...props} seatsLeft={0} />);
    expect(full).toContain('>Join waitlist<');
    expect(text(full)).toContain(
      "This group goes on the waitlist. You're only charged if you get a place.",
    );
    expect(full).toContain('value="waitlist"');
    // 2 seats left, party of 3 (me + 2 guests) does not fit: predicted waitlist
    const bigParty = renderToStaticMarkup(
      <RegisterForm {...props} seatsLeft={2} initialParty={2} />,
    );
    expect(bigParty).toContain('>Join waitlist<');
    expect(bigParty).toContain('value="waitlist"');
    // the same seats and a party of 2 fit
    const fits = renderToStaticMarkup(<RegisterForm {...props} seatsLeft={2} initialParty={1} />);
    expect(fits).toContain('>Register<');
    expect(fits).not.toContain('This group goes on the waitlist');
    const open = renderToStaticMarkup(<RegisterForm {...props} />);
    expect(open).toContain('>Register<');
    expect(open).toContain('value="register"');
  });

  it('shows the pre-submit total in its own role=status line from me.unitFee and session.fees (AC-HAPPY-2)', () => {
    const solo = renderToStaticMarkup(<RegisterForm {...props} />);
    expect(text(solo)).toContain('Total: $17.00 for 1 person.');
    const html = renderToStaticMarkup(<RegisterForm {...props} initialParty={2} />);
    expect(text(html)).toContain('Total: $51.00 for 3 people.');
    expect(html).toMatch(/<p[^>]*role="status"[^>]*>Total: \$51\.00 for 3 people\.<\/p>/);
  });

  it('BY_SEX: estimate wording, and a partial total until each guest sex is chosen (session.fees)', () => {
    const fees = {
      ...props.fees,
      flat: null,
      male: '20.00',
      female: '17.00',
      other: '18.00',
    } as unknown as typeof props.fees;
    const bySex = { ...props, pricing: 'BY_SEX' as const, fees, unitFee: '20.00' as never };
    const partial = renderToStaticMarkup(<RegisterForm {...bySex} initialParty={1} />);
    expect(text(partial)).toContain(
      "Total so far: $20.00. Choose each guest's sex to see the rest.",
    );
    const complete = renderToStaticMarkup(
      <RegisterForm
        {...bySex}
        initialParty={1}
        initialGuests={[{ sex: 'FEMALE', skillLevel: '', displayName: '' }]}
      />,
    );
    expect(text(complete)).toContain('Estimated total: $37.00 for 2 people.');
  });
});

describe('full session (AC-HAPPY-2 aftermath)', () => {
  it('renders session.waitlistLength in "Full · n on the waitlist" and offers to join the waitlist', () => {
    const html = panel(readFixture({ session: { seatsLeft: 0, waitlistLength: 3 } }));
    expect(text(html)).toContain('Full · 3 on the waitlist');
    expect(html).toContain('>Join waitlist<');
  });
});

describe('registered (AC-ENTRY-3, AC-HAPPY-1/2)', () => {
  const guests = [
    { position: 1, sex: 'FEMALE', skillLevel: 'INTERMEDIATE', displayName: 'Ana' },
    { position: 2, sex: 'MALE', skillLevel: 'BEGINNER', displayName: null },
  ];
  const html = panel(
    active(confirmed({ guestCount: 2, guests }), {
      me: { registration: confirmed({ guestCount: 2, guests }), estimatedTotal: '51.00' },
    }),
  );

  it('says "You\'re in." with the group and guest lines of me.registration, and the server fee estimate', () => {
    const copy = text(html);
    expect(copy).toContain("You're in.");
    expect(copy).toContain('Your group: you + 2 guests');
    expect(copy).toContain('Guest 1: Ana, Female, Intermediate');
    expect(copy).toContain('Guest 2: Male, Beginner');
    expect(copy).toContain('Fee: $51.00 for you and 2 guests, charged after the game.');
  });

  it('has a Withdraw button (accessible name "Withdraw from this session"), no register form, and no native dialog', () => {
    const trigger = buttonTag(html, 'Withdraw');
    expect(trigger).toContain('aria-expanded="false"');
    expect(trigger).toContain('aria-label="Withdraw from this session"');
    expect(html).not.toContain('Bringing guests?');
    expect(html).not.toMatch(/<dialog|window\.confirm/);
  });

  it('a promotion shows me.registration.promotedAt, and after the deadline the late note (AC-ASYNC-4, UI/UX 12)', () => {
    const promoted = active(confirmed({ promotedAt: '2026-10-30T01:00:00.000Z' }));
    expect(text(panel(promoted))).toContain(
      'You were moved off the waitlist on Fri 30 Oct, 2:00 pm.',
    );
    expect(text(panel(promoted))).not.toContain("If you can't play, withdraw here");
    const late = active(confirmed({ promotedAt: '2026-11-02T01:00:00.000Z' }));
    expect(text(panel(late, AFTER_DEADLINE))).toContain("If you can't play, withdraw here");
  });

  it('R17: source AUTO_ENROL shows "Added automatically (Auto Enroll)"; a MEMBER row never does', () => {
    expect(text(panel(active(confirmed({ source: 'AUTO_ENROL' }))))).toContain(
      'Added automatically (Auto Enroll)',
    );
    expect(text(panel(active(confirmed({ source: 'MEMBER' }))))).not.toContain(
      'Added automatically',
    );
    expect(text(panel(active(waitlisted({ source: 'AUTO_ENROL' }))))).toContain(
      'Added automatically (Auto Enroll)',
    );
  });

  it('R15: a confirmed caller on a skill-level session names me.feeLevel (the snapshot)', () => {
    const data = active(confirmed({ registrantSkillLevel: 'INTERMEDIATE' }), {
      session: { pricingStructure: 'BY_SKILL_LEVEL' },
      me: {
        registration: confirmed({ registrantSkillLevel: 'INTERMEDIATE' }),
        estimatedTotal: '20.00',
        feeLevel: 'INTERMEDIATE',
      },
    });
    expect(text(panel(data))).toContain('Your fee (Intermediate): $20.00, charged after the game.');
  });

  it('R15: a never-registered caller on a skill-level session sees the fee line naming me.feeLevel', () => {
    const data = readFixture({
      session: { pricingStructure: 'BY_SKILL_LEVEL' },
      me: { unitFee: '20.00', estimatedTotal: '20.00', feeLevel: 'INTERMEDIATE' },
    });
    expect(text(panel(data))).toContain('Your fee (Intermediate): $20.00, charged after the game.');
  });

  it('R15: a waitlisted caller names me.feeLevel too, and a flat session names none', () => {
    const waiting = active(waitlisted({ registrantSkillLevel: 'ADVANCED' }), {
      session: { pricingStructure: 'BY_SKILL_LEVEL' },
      me: {
        registration: waitlisted({ registrantSkillLevel: null }),
        estimatedTotal: '20.00',
        feeLevel: 'ADVANCED',
      },
    });
    expect(text(panel(waiting))).toContain('Your fee (Advanced): $20.00');
    expect(text(panel(readFixture({ me: { feeLevel: 'ADVANCED' } })))).toContain(
      'Fee: $17.00 per person',
    );
  });

  it('BY_SEX / BY_SKILL_LEVEL list session.fees', () => {
    const data = readFixture({
      session: {
        pricingStructure: 'BY_SEX',
        fees: {
          flat: null,
          male: '20.00',
          female: '17.00',
          other: '18.00',
          beginner: null,
          intermediate: null,
          advanced: null,
        },
      },
      me: { unitFee: '20.00' },
    });
    const copy = text(panel(data));
    expect(copy).toContain('Fees depend on sex. Guests are charged by their own sex.');
    expect(copy).toContain('Male: $20.00');
    expect(copy).toContain('Female: $17.00');
    expect(copy).toContain('Your fee: $20.00, charged after the game.');
  });
});

describe('WithdrawConfirm: wording follows the deadline, the waitlist and the group (R2, R9)', () => {
  const base = {
    teamId: TEAM_ID,
    sessionId: SESSION_ID,
    kind: 'withdraw' as const,
    guestCount: 0,
    fee: '17.00',
    waitlistLength: 0,
    defaultOpen: true,
  };

  it('early: free wording and expectLate=false', () => {
    const html = renderToStaticMarkup(<WithdrawConfirm {...base} late={false} />);
    expect(text(html)).toContain("Withdraw from this session? You won't be charged.");
    expect(html).toMatch(/name="expectLate"[^>]*value="false"/);
    expect(html).toContain('name="intent"');
    expect(html).toMatch(/role="group"/);
  });

  it('late with an empty waitlist (session.waitlistLength 0): states the possible charge, expectLate=true', () => {
    const html = renderToStaticMarkup(<WithdrawConfirm {...base} late />);
    expect(text(html)).toContain(
      "no one is waiting for a place, so you'll be charged $17.00 unless someone takes your place before the game. Withdraw anyway?",
    );
    expect(html).toMatch(/name="expectLate"[^>]*value="true"/);
  });

  it('late with a waiting group: the AC-HAPPY-5 wording', () => {
    const html = renderToStaticMarkup(<WithdrawConfirm {...base} late waitlistLength={2} />);
    expect(text(html)).toContain(
      "If a waitlisted player takes your place you won't be charged. Otherwise you'll be charged $17.00.",
    );
  });

  it('leave waitlist: the UI/UX prompt, trigger "Leave waitlist"', () => {
    const html = renderToStaticMarkup(
      <WithdrawConfirm {...base} kind="leave" late={false} defaultOpen={false} />,
    );
    expect(html).toContain('>Leave waitlist<');
    const open = renderToStaticMarkup(<WithdrawConfirm {...base} kind="leave" late={false} />);
    expect(text(open)).toContain(
      "Leave the waitlist? You won't be charged. If you change your mind you can join again, but you'll go to the back of the line.",
    );
    expect(open).toMatch(/name="intent"[^>]*value="leave"/);
  });

  it('a 409 cancellation_terms_changed result re-opens the confirm with the late wording (the late props re-render)', () => {
    // After the 409 the page re-renders with deadlinePassed true; the confirm is open and says so.
    const data = active(confirmed());
    const html = panel(data, AFTER_DEADLINE);
    expect(text(html)).toContain('The free cancellation deadline has passed.');
    const trigger = buttonTag(html, 'Withdraw');
    expect(trigger).toContain('aria-expanded="false"');
  });
});

describe('waitlisted (AC-ENTRY-3, AC-HAPPY-3, AC-HAPPY-7)', () => {
  const html = panel(active(waitlisted({ waitlistRank: 3 })));

  it('shows me.registration.waitlistRank as the number, never a raw queue position', () => {
    expect(text(html)).toContain(
      "You're on the waitlist (#3). We'll email you if a place opens up.",
    );
    expect(text(html)).toContain('Charged only if you get a place.');
    expect(html).toContain('>Leave waitlist<');
    expect(html).not.toContain('Bringing guests?');
  });

  it('rank 1 says first in line; free seats (session.seatsLeft >= 1) add the passed-over line without counting', () => {
    const first = panel(
      active(waitlisted({ waitlistRank: 1 }), { session: { seatsLeft: 0, waitlistLength: 1 } }),
    );
    expect(text(first)).toContain("You're first in line.");
    expect(text(first)).not.toContain('Smaller groups');
    const passed = panel(active(waitlisted({ waitlistRank: 1 }), { session: { seatsLeft: 1 } }));
    expect(text(passed)).toContain('Smaller groups behind you may get places first');
  });
});

describe('withdrawn (R11)', () => {
  it('EARLY: "You won\'t be charged." and the register form again', () => {
    const data = readFixture({
      me: {
        registration: registrationFixture({
          status: 'WITHDRAWN',
          withdrawalKind: 'EARLY',
          withdrawnAt: '2026-10-29T00:00:00.000Z',
        }),
      },
    });
    const html = panel(data);
    expect(text(html)).toContain("You withdrew from this session. You won't be charged.");
    expect(html).toContain('Bringing guests?');
  });

  it('LATE with a fee due: the R2 copy with me.estimatedTotal and the register form', () => {
    const data = readFixture({
      me: {
        registration: registrationFixture({
          status: 'WITHDRAWN',
          withdrawalKind: 'LATE',
          withdrawalFeeDue: true,
          guestCount: 2,
          withdrawnAt: '2026-11-02T00:00:00.000Z',
        }),
        estimatedTotal: '51.00',
      },
    });
    const html = panel(data, AFTER_DEADLINE);
    expect(text(html)).toContain(
      'No one has taken your place yet, so the $51.00 fee for you and 2 guests applies unless someone takes your place before the game.',
    );
    expect(html).toContain('Bringing guests?');
  });
});

describe('blocked and closed states render the read-model reason', () => {
  it('overdue_payments: the debt copy with me.overdueCount, no form (AC-ERROR-1)', () => {
    const html = panel(
      readFixture({
        me: { overdueCount: 3 },
        canRegister: false,
        blockedReason: 'overdue_payments',
      }),
    );
    expect(text(html)).toContain(
      'You have 3 overdue payments across your teams. Pay them before registering for more sessions. If you think this is wrong, ask your team admin.',
    );
    expect(html).not.toContain('Bringing guests?');
    expect(html).not.toContain('>Register<');
    expect(text(html)).toContain('3 of 10 places left');
  });

  it('a registered player with overdue payments still sees their registration and Withdraw', () => {
    const html = panel(active(confirmed(), { me: { registration: confirmed(), overdueCount: 4 } }));
    expect(text(html)).toContain("You're in.");
    expect(text(html)).not.toContain('overdue payments');
    expect(html).toContain('>Withdraw<');
  });

  it('closed (blockedReason session_not_open): "Registration is closed.", no form, no buttons; a debtor sees this, not the debt copy', () => {
    const html = panel(
      readFixture({
        me: { overdueCount: 3 },
        canRegister: false,
        blockedReason: 'session_not_open',
      }),
    );
    expect(text(html)).toContain('Registration is closed.');
    expect(text(html)).not.toContain('overdue');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<button');
  });

  it('cancelled session (R27, P-2): the cancelled copy wins over a CONFIRMED row, with no Withdraw and no "You\'re in."', () => {
    const html = panel(
      active(confirmed(), {
        session: { status: 'CANCELLED' },
        blockedReason: 'session_not_open',
      }),
    );
    expect(text(html)).toContain('This session has been cancelled.');
    expect(text(html)).not.toContain("You're in.");
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<form');
  });

  it('public capacity 0 (blockedReason party_exceeds_capacity): "no public places", no form', () => {
    const html = panel(
      readFixture({
        session: { publicCapacity: 0, seatsLeft: 0 },
        canRegister: false,
        blockedReason: 'party_exceeds_capacity',
      }),
    );
    expect(text(html)).toContain('This session has no public places.');
    expect(html).not.toContain('Bringing guests?');
  });

  it('a started session shows a past-tense registration plus the closed line', () => {
    const html = panel(
      readFixture({
        me: { registration: waitlisted() },
        canRegister: false,
        blockedReason: 'session_not_open',
      }),
    );
    expect(text(html)).toContain("The session has started and you didn't get a place.");
    expect(text(html)).toContain('Registration is closed.');
  });
});

describe('PlayerSessionSummary (named apart from the admin SessionSummary, R23)', () => {
  it('shows the server location, address and Auckland time range, and links back to the team page', () => {
    const html = renderToStaticMarkup(
      <PlayerSessionSummary
        teamId={TEAM_ID}
        teamName="Rosedale Badminton"
        session={readFixture().session}
      />,
    );
    const copy = text(html);
    expect(copy).toContain('Rosedale Courts');
    expect(copy).toContain('1 Court Rd, Albany');
    expect(copy).toContain('Wed 4 Nov');
    expect(copy).toContain('8:00');
    expect(html).toContain(`href="/teams/${TEAM_ID}"`);
    expect(html).toContain('aria-label="Back to Rosedale Badminton"');
    expect(html).toContain('<h1');
  });
});

describe('NotMember (AC-ENTRY-2)', () => {
  it('says so with a way back and no form', () => {
    const html = renderToStaticMarkup(<NotMember teamId={TEAM_ID} />);
    expect(text(html)).toContain('You need to be a member of this team to register.');
    expect(html).toContain(`href="/teams/${TEAM_ID}"`);
    expect(html).toContain('View team page');
    expect(html).not.toContain('<form');
  });
});

describe('UpcomingSessions (R8, AC-ENTRY-4 web side)', () => {
  it('rows link to the player page and render the server places line and my status', () => {
    const data = upcomingFixture(
      [
        { me: { status: 'CONFIRMED', waitlistRank: null } },
        { seatsLeft: 0, waitlistLength: 2, me: { status: 'WAITLISTED', waitlistRank: 2 } },
        { seatsLeft: 1, waitlistLength: 2 },
      ],
      true,
    );
    const html = renderToStaticMarkup(
      <UpcomingSessions teamId={TEAM_ID} result={{ ok: true, data }} />,
    );
    const copy = text(html);
    expect(html).toContain('<h2');
    expect(copy).toContain('Upcoming sessions');
    expect(html).toContain(`href="/teams/${TEAM_ID}/sessions/${data.sessions[0]?.id ?? ''}"`);
    expect(copy).toContain('Wed 4 Nov, 8:00 am · Rosedale Courts');
    expect(copy).toContain('3 of 10 places left');
    expect(copy).toContain('Full · 2 on the waitlist');
    expect(copy).toContain('1 of 10 places left · 2 on the waitlist');
    expect(copy).toContain("You're in");
    expect(copy).toContain('Waitlist #2');
    expect(copy).toContain('Showing the next 10 sessions.');
  });

  it('empty and failed states are contained to the section', () => {
    const empty = renderToStaticMarkup(
      <UpcomingSessions teamId={TEAM_ID} result={{ ok: true, data: upcomingFixture() }} />,
    );
    expect(text(empty)).toContain('No sessions are open for registration right now.');
    const failed = renderToStaticMarkup(
      <UpcomingSessions teamId={TEAM_ID} result={{ ok: false }} />,
    );
    expect(text(failed)).toContain("We can't load sessions right now. Try again in a minute.");
    expect(text(failed)).toContain('Upcoming sessions');
  });
});

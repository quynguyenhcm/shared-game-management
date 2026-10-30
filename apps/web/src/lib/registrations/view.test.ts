import { describe, expect, it } from 'vitest';
import {
  AFTER_DEADLINE,
  BEFORE_DEADLINE,
  readFixture,
  registrationFixture,
  TEAM_ID,
  SESSION_ID,
} from './fixtures.ts';
import { playerSessionPath, teamPagePath } from './paths.ts';
import { panelView } from './view.ts';

describe('playerSessionPath (R23: the player page, never the admin sessionPath)', () => {
  it('is /teams/[teamId]/sessions/[sessionId], not under /manage', () => {
    expect(playerSessionPath(TEAM_ID, SESSION_ID)).toBe(`/teams/${TEAM_ID}/sessions/${SESSION_ID}`);
    expect(playerSessionPath(TEAM_ID, SESSION_ID)).not.toContain('/manage');
    expect(teamPagePath(TEAM_ID)).toBe(`/teams/${TEAM_ID}`);
  });
});

describe('panelView: one state per read model, decided only by server fields', () => {
  const confirmed = registrationFixture({ status: 'CONFIRMED' });
  const waitlisted = registrationFixture({ status: 'WAITLISTED', waitlistRank: 2 });
  const withdrawn = registrationFixture({
    status: 'WITHDRAWN',
    withdrawalKind: 'EARLY',
    withdrawnAt: '2026-10-29T00:00:00.000Z',
  });

  const rows: readonly {
    name: string;
    response: ReturnType<typeof readFixture>;
    kind: string;
  }[] = [
    { name: 'no registration, canRegister true -> open', response: readFixture(), kind: 'open' },
    {
      name: 'session.status CANCELLED beats an active registration (R27, P-2)',
      response: readFixture({
        session: { status: 'CANCELLED' },
        me: { registration: confirmed },
        canRegister: false,
        blockedReason: 'session_not_open',
      }),
      kind: 'cancelled',
    },
    {
      name: 'blockedReason session_not_open -> closed',
      response: readFixture({ canRegister: false, blockedReason: 'session_not_open' }),
      kind: 'closed',
    },
    {
      name: 'session.status COMPLETED -> closed',
      response: readFixture({
        session: { status: 'COMPLETED' },
        canRegister: false,
        blockedReason: 'session_not_open',
      }),
      kind: 'closed',
    },
    {
      name: 'a visible closed session says session_not_open even for a debtor (read-model reason shown)',
      response: readFixture({
        me: { overdueCount: 3 },
        canRegister: false,
        blockedReason: 'session_not_open',
      }),
      kind: 'closed',
    },
    {
      name: 'me.registration CONFIRMED -> confirmed',
      response: readFixture({
        me: { registration: confirmed },
        canRegister: false,
        blockedReason: 'already_registered',
      }),
      kind: 'confirmed',
    },
    {
      name: 'me.registration WAITLISTED -> waitlisted',
      response: readFixture({
        me: { registration: waitlisted },
        canRegister: false,
        blockedReason: 'already_registered',
      }),
      kind: 'waitlisted',
    },
    {
      name: 'an active registration beats the debt block (withdrawal is never blocked by debt)',
      response: readFixture({
        me: { registration: confirmed, overdueCount: 4 },
        canRegister: false,
        blockedReason: 'already_registered',
      }),
      kind: 'confirmed',
    },
    {
      name: 'blockedReason overdue_payments -> debt_blocked',
      response: readFixture({
        me: { overdueCount: 3 },
        canRegister: false,
        blockedReason: 'overdue_payments',
      }),
      kind: 'debt_blocked',
    },
    {
      name: 'blockedReason party_exceeds_capacity (public capacity 0) -> no_places',
      response: readFixture({
        session: { publicCapacity: 0, seatsLeft: 0 },
        canRegister: false,
        blockedReason: 'party_exceeds_capacity',
      }),
      kind: 'no_places',
    },
    {
      name: 'me.registration WITHDRAWN and canRegister -> withdrawn (form again)',
      response: readFixture({ me: { registration: withdrawn } }),
      kind: 'withdrawn',
    },
    {
      name: 'WITHDRAWN and debt -> debt_blocked',
      response: readFixture({
        me: { registration: withdrawn, overdueCount: 3 },
        canRegister: false,
        blockedReason: 'overdue_payments',
      }),
      kind: 'debt_blocked',
    },
  ];

  it.each(rows)('$name', ({ response, kind }) => {
    expect(panelView(response, BEFORE_DEADLINE).kind).toBe(kind);
  });

  it('deadlinePassed is the server clock against session.cancellationDeadline', () => {
    const response = readFixture();
    expect(panelView(response, BEFORE_DEADLINE).deadlinePassed).toBe(false);
    expect(panelView(response, AFTER_DEADLINE).deadlinePassed).toBe(true);
    // exactly at the deadline is still early (now <= deadline, AC-VERIFY-5)
    expect(
      panelView(response, new Date(response.session.cancellationDeadline ?? '')).deadlinePassed,
    ).toBe(false);
  });

  it('a session without a deadline never reports it passed', () => {
    const response = readFixture({ session: { cancellationDeadline: null } });
    expect(panelView(response, AFTER_DEADLINE).deadlinePassed).toBe(false);
  });
});

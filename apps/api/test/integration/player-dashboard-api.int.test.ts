/**
 * The player dashboard read models over HTTP on a real PostgreSQL (player-dashboard Phase 1): `GET /me/sessions/open` and
 * `GET /me/registrations`. ACs: AC-HAPPY-1 and AC-HAPPY-2 (data), AC-HAPPY-3 (data), AC-HAPPY-7, AC-ASYNC-2 (data).
 * (`GET /payments/me?status=PAID`, AC-HAPPY-6, lives next to the other payer lists in payment-attempts.int.test.ts.)
 *
 * Every session, fee and place count is seeded with a distinct value, so a stubbed or hard-coded field fails by name.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DashboardRegistrationsResponse, OpenSessionsResponse } from '@sgm/shared';
import { START_TIME, buildAuthTestApp, type AuthTestApp } from '../helpers/auth-app.ts';
import {
  advanceSessionTo,
  insertGuest,
  insertPayment,
  insertPaymentAttempt,
  insertPublishedSession,
  insertRegistration,
  insertSession,
  type RegistrationInput,
  insertTeam,
  insertTeamMember,
  insertUser,
  type SessionFees,
} from '../helpers/factories.ts';
import { call, errorOf, httpMember, type HttpMember } from '../helpers/registrations-http.ts';
import { createTestDatabase, inTransaction, type TestDatabase } from '../helpers/test-db.ts';

const MONEY = /^\d+\.\d{2}$/;

let database: TestDatabase;
let h: AuthTestApp;

beforeAll(async () => {
  database = await createTestDatabase({ poolMax: 20 });
  h = await buildAuthTestApp(database.pool);
});
afterAll(async () => {
  await h.close();
  await database.close();
});
beforeEach(() => {
  h.clock.set(START_TIME);
});

// ---------------------------------------------------------------------------------------------
// Scene helpers
// ---------------------------------------------------------------------------------------------

interface SessionSpec extends SessionFees {
  readonly hours: number;
  readonly location: string;
  readonly address: string;
  readonly maxPlayers?: number;
  readonly reservedSeats?: number;
}

/** A PUBLISHED session starting `hours` from the clock (negative: already started) with its own place name and address. */
async function session(teamId: string, spec: SessionSpec): Promise<string> {
  const { sessionId } = await insertPublishedSession(database.pool, teamId, {
    now: h.clock.now(),
    startsInHours: spec.hours,
    pricing: spec.pricing,
    flat: spec.flat,
    male: spec.male,
    female: spec.female,
    other: spec.other,
    beginner: spec.beginner,
    intermediate: spec.intermediate,
    advanced: spec.advanced,
    maxPlayers: spec.maxPlayers,
    reservedSeats: spec.reservedSeats,
  });
  await database.pool.query(`UPDATE game_sessions SET location = $2, address = $3 WHERE id = $1`, [
    sessionId,
    spec.location,
    spec.address,
  ]);
  return sessionId;
}

const team = (name: string): Promise<string> =>
  insertTeam(database.pool, { name, payoutConfigured: true });

const join = (
  userId: string,
  teamId: string,
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'BANNED' = 'APPROVED',
  skillLevel: 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED' = 'BEGINNER',
): Promise<string> => insertTeamMember(database.pool, { teamId, userId, status, skillLevel });

/** A registration with its guest rows in one transaction (the guest count and rows are checked together at COMMIT). */
const party = (input: RegistrationInput, guests: number): Promise<string> =>
  inTransaction(database.pool, async (client) => {
    const id = await insertRegistration(client, { ...input, guestCount: guests });
    for (let position = 1; position <= guests; position += 1) {
      await insertGuest(client, id, position);
    }
    return id;
  });

/** Another APPROVED player who holds a CONFIRMED party of `1 + guests` places. */
async function takePlaces(teamId: string, sessionId: string, guests = 0): Promise<string> {
  const userId = await insertUser(database.pool, 'MALE');
  await join(userId, teamId);
  await party({ sessionId, teamId, userId }, guests);
  return userId;
}

async function waitOn(teamId: string, sessionId: string, queuePosition: number): Promise<string> {
  const userId = await insertUser(database.pool, 'MALE');
  await join(userId, teamId);
  await insertRegistration(database.pool, {
    sessionId,
    teamId,
    userId,
    status: 'WAITLISTED',
    queuePosition,
  });
  return userId;
}

const open = (who: HttpMember | null) => call(h, 'GET', '/me/sessions/open', who?.token ?? null);
const registrations = (who: HttpMember | null, query = '') =>
  call(h, 'GET', `/me/registrations${query}`, who?.token ?? null);
const openBody = async (who: HttpMember): Promise<OpenSessionsResponse> =>
  (await open(who)).json<OpenSessionsResponse>();
const registrationsBody = async (
  who: HttpMember,
  query = '',
): Promise<DashboardRegistrationsResponse> =>
  (await registrations(who, query)).json<DashboardRegistrationsResponse>();

async function instants(sessionId: string): Promise<{ startsAt: string; endsAt: string }> {
  const { rows } = await database.pool.query<{ starts_at: Date; ends_at: Date }>(
    `SELECT starts_at, ends_at FROM game_sessions WHERE id = $1`,
    [sessionId],
  );
  return {
    startsAt: (rows[0]?.starts_at as Date).toISOString(),
    endsAt: (rows[0]?.ends_at as Date).toISOString(),
  };
}

// ---------------------------------------------------------------------------------------------
// GET /me/sessions/open (AC-HAPPY-1, AC-HAPPY-2 data)
// ---------------------------------------------------------------------------------------------

describe('GET /me/sessions/open', () => {
  it("lists exactly the caller's APPROVED teams' published, not-started sessions, soonest first, ties by id, with every card field", async () => {
    const a = await team('Alpha Club');
    const b = await team('Bravo Club');
    const c = await team('Charlie Club');
    const player = await httpMember(h, a, { sex: 'FEMALE', skill: 'INTERMEDIATE' });
    await join(player.userId, b, 'APPROVED', 'ADVANCED');
    await join(player.userId, c, 'PENDING');

    const s1 = await session(a, {
      hours: 72,
      location: 'Kolmar Hall',
      address: '1 Kolmar Road, Mt Eden',
      flat: '12.00',
      maxPlayers: 8,
    });
    const s2 = await session(a, {
      hours: 72,
      location: 'Pah Road Courts',
      address: '22 Pah Road, Epsom',
      pricing: 'BY_SEX',
      male: '10.00',
      female: '13.50',
      other: '11.00',
      maxPlayers: 6,
      reservedSeats: 1,
    });
    const b1 = await session(b, {
      hours: 48,
      location: 'Bravo Arena',
      address: '9 Bravo Street, Newmarket',
      pricing: 'BY_SKILL_LEVEL',
      beginner: '9.00',
      intermediate: '11.00',
      advanced: '15.00',
      maxPlayers: 4,
    });
    // Excluded: a PENDING team's session, a DRAFT, a CANCELLED one and one that has started.
    await session(c, {
      hours: 24,
      location: 'Charlie Gym',
      address: '3 Charlie Lane',
      flat: '5.00',
    });
    await insertSession(database.pool, a, {}, { status: 'DRAFT' });
    const cancelled = await session(a, {
      hours: 30,
      location: 'Cancelled Hall',
      address: '4 Gone Street',
    });
    await advanceSessionTo(database.pool, cancelled, 'CANCELLED');
    await session(a, { hours: -24, location: 'Started Hall', address: '5 Past Street' });

    // s1: 5 of 8 places taken (parties of 3 and 2) and two waiting; b1: full.
    await takePlaces(a, s1, 2);
    await takePlaces(a, s1, 1);
    await waitOn(a, s1, 1);
    await waitOn(a, s1, 2);
    for (let i = 0; i < 4; i += 1) await takePlaces(b, b1);

    const response = await open(player);
    expect(response.statusCode).toBe(200);
    const body = response.json<OpenSessionsResponse>();
    expect(body.hasMore).toBe(false);
    expect(body.overdueCount).toBe(0);
    const tied = [s1, s2].sort();
    expect(body.sessions.map((row) => row.sessionId)).toEqual([b1, ...tied]);

    const byId = Object.fromEntries(body.sessions.map((row) => [row.sessionId, row]));
    expect(byId[b1]).toEqual({
      sessionId: b1,
      teamId: b,
      teamName: 'Bravo Club',
      location: 'Bravo Arena',
      address: '9 Bravo Street, Newmarket',
      ...(await instants(b1)),
      pricingStructure: 'BY_SKILL_LEVEL',
      unitFee: '15.00',
      feeLevel: 'ADVANCED',
      publicCapacity: 4,
      seatsLeft: 0,
      waitlistLength: 0,
      me: null,
      canRegister: true,
      blockedReason: null,
    });
    expect(byId[s1]).toEqual({
      sessionId: s1,
      teamId: a,
      teamName: 'Alpha Club',
      location: 'Kolmar Hall',
      address: '1 Kolmar Road, Mt Eden',
      ...(await instants(s1)),
      pricingStructure: 'FLAT',
      unitFee: '12.00',
      feeLevel: null,
      publicCapacity: 8,
      seatsLeft: 3,
      waitlistLength: 2,
      me: null,
      canRegister: true,
      blockedReason: null,
    });
    expect(byId[s2]).toEqual({
      sessionId: s2,
      teamId: a,
      teamName: 'Alpha Club',
      location: 'Pah Road Courts',
      address: '22 Pah Road, Epsom',
      ...(await instants(s2)),
      pricingStructure: 'BY_SEX',
      unitFee: '13.50',
      feeLevel: null,
      publicCapacity: 5,
      seatsLeft: 5,
      waitlistLength: 0,
      me: null,
      canRegister: true,
      blockedReason: null,
    });
  });

  it('reports me, canRegister, blockedReason and overdueCount from the caller’s own rows', async () => {
    const t = await team('Delta Club');
    const player = await httpMember(h, t, { sex: 'FEMALE', skill: 'ADVANCED' });
    const confirmed = await session(t, {
      hours: 24,
      location: 'Hall One',
      address: '1 One Street',
      flat: '12.00',
    });
    const waitlisted = await session(t, {
      hours: 25,
      location: 'Hall Two',
      address: '2 Two Street',
      flat: '13.00',
    });
    await session(t, {
      hours: 26,
      location: 'Hall Three',
      address: '3 Three Street',
      flat: '14.00',
      maxPlayers: 4,
      reservedSeats: 4,
    });
    const withdrawn = await session(t, {
      hours: 27,
      location: 'Hall Four',
      address: '4 Four Street',
      flat: '15.00',
    });
    const inTx = (
      status: 'CONFIRMED' | 'WAITLISTED' | 'WITHDRAWN',
      sessionId: string,
      q?: number,
    ) =>
      insertRegistration(database.pool, {
        sessionId,
        teamId: t,
        userId: player.userId,
        status,
        queuePosition: q,
      });
    await inTx('CONFIRMED', confirmed);
    await waitOn(t, waitlisted, 1);
    await inTx('WAITLISTED', waitlisted, 4);
    await inTx('WITHDRAWN', withdrawn);

    const first = await openBody(player);
    expect(first.overdueCount).toBe(0);
    const by = (body: OpenSessionsResponse) =>
      Object.fromEntries(body.sessions.map((row) => [row.location, row]));
    expect(by(first)['Hall One']).toMatchObject({
      me: { status: 'CONFIRMED', waitlistRank: null },
      canRegister: false,
      blockedReason: 'already_registered',
      unitFee: '12.00',
    });
    expect(by(first)['Hall Two']).toMatchObject({
      me: { status: 'WAITLISTED', waitlistRank: 2 },
      canRegister: false,
      blockedReason: 'already_registered',
    });
    expect(by(first)['Hall Three']).toMatchObject({
      publicCapacity: 0,
      canRegister: false,
      blockedReason: 'party_exceeds_capacity',
    });
    expect(by(first)['Hall Four']).toMatchObject({ me: null, canRegister: true });

    // Three OVERDUE payments elsewhere turn the open session into a debt block.
    for (let i = 0; i < 3; i += 1) {
      const elsewhere = await team(`Elsewhere ${i}`);
      const past = await session(elsewhere, {
        hours: -(100 + i),
        location: `Past ${i}`,
        address: `${i} Past Road`,
      });
      const registrationId = await insertRegistration(database.pool, {
        sessionId: past,
        teamId: elsewhere,
        userId: player.userId,
      });
      await insertPayment(database.pool, {
        userId: player.userId,
        teamId: elsewhere,
        registrationId,
        amount: '17.00',
        status: 'OVERDUE',
      });
    }
    const second = await openBody(player);
    expect(second.overdueCount).toBe(3);
    expect(by(second)['Hall Four']).toMatchObject({
      canRegister: false,
      blockedReason: 'overdue_payments',
    });
    expect(by(second)['Hall One']?.blockedReason).toBe('already_registered');
  });

  it('answers 401 without a session, with no-store on every answer, money as 2dp and instants as ISO UTC', async () => {
    const t = await team('Echo Club');
    const player = await httpMember(h, t);
    await session(t, { hours: 10, location: 'Echo Hall', address: '6 Echo Street', flat: '12.00' });

    const anonymous = await open(null);
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers['cache-control']).toBe('no-store');
    expect(errorOf(anonymous).code).toBe('unauthenticated');

    const ok = await open(player);
    expect(ok.headers['cache-control']).toBe('no-store');
    const row = ok.json<OpenSessionsResponse>().sessions[0];
    expect(row?.unitFee).toMatch(MONEY);
    for (const instant of [row?.startsAt, row?.endsAt]) {
      expect(new Date(instant as string).toISOString()).toBe(instant);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// GET /me/registrations (AC-HAPPY-3 data, AC-ASYNC-2 data)
// ---------------------------------------------------------------------------------------------

describe('GET /me/registrations', () => {
  it('lists every registration with its state, payment join and estimate; Upcoming soonest first, Past newest first; a free withdrawal is hidden', async () => {
    const t = await team('Foxtrot Club');
    const player = await httpMember(h, t, { sex: 'FEMALE', skill: 'INTERMEDIATE' });
    const mk = (hours: number, location: string, flat: string) =>
      session(t, { hours, location, address: `${location} Road, Auckland`, flat });
    const reg = (
      sessionId: string,
      options: Partial<Parameters<typeof insertRegistration>[1]> = {},
    ) =>
      insertRegistration(database.pool, {
        sessionId,
        teamId: t,
        userId: player.userId,
        ...options,
      });

    // Upcoming: a CONFIRMED party of two (no payment yet) and a WAITLISTED row behind a gap in the queue.
    const upConfirmed = await mk(72, 'Up Confirmed', '12.00');
    const upConfirmedReg = await party(
      { sessionId: upConfirmed, teamId: t, userId: player.userId },
      1,
    );
    const upWaiting = await mk(48, 'Up Waiting', '10.00');
    await waitOn(t, upWaiting, 1);
    await reg(upWaiting, { status: 'WAITLISTED', queuePosition: 5 });
    // Hidden: a free (EARLY) withdrawal.
    const hidden = await mk(60, 'Hidden Early', '11.00');
    await reg(hidden, { status: 'WITHDRAWN', withdrawalFeeDue: false });
    // Past: a cancelled session, an overdue billed game, a game paid from the wallet side, a billed late withdrawal.
    const cancelled = await mk(100, 'Cancelled Past', '9.00');
    const cancelledReg = await reg(cancelled);
    await advanceSessionTo(database.pool, cancelled, 'CANCELLED');
    const overdue = await mk(-240, 'Overdue Past', '12.00');
    const overdueReg = await party({ sessionId: overdue, teamId: t, userId: player.userId }, 1);
    const overduePayment = await insertPayment(database.pool, {
      userId: player.userId,
      teamId: t,
      registrationId: overdueReg,
      amount: '24.00',
      status: 'OVERDUE',
      dueDate: new Date('2026-09-30T00:00:00.000Z'),
    });
    const paid = await mk(-480, 'Paid Past', '8.00');
    const paidReg = await reg(paid);
    const paidPayment = await insertPayment(database.pool, {
      userId: player.userId,
      teamId: t,
      registrationId: paidReg,
      amount: '8.00',
      status: 'PAID',
      paidAt: new Date('2026-09-20T00:00:00.000Z'),
    });
    const late = await mk(-120, 'Late Past', '17.00');
    const lateReg = await reg(late, { status: 'WITHDRAWN', withdrawalFeeDue: true });
    const latePayment = await insertPayment(database.pool, {
      userId: player.userId,
      teamId: t,
      registrationId: lateReg,
      amount: '17.00',
      dueDate: new Date('2026-10-12T00:00:00.000Z'),
    });

    const body = await registrationsBody(player);
    expect(body.nextCursor).toBeNull();
    expect(body.upcoming.map((row) => row.location)).toEqual(['Up Waiting', 'Up Confirmed']);
    expect(body.past.map((row) => row.location)).toEqual([
      'Cancelled Past',
      'Late Past',
      'Overdue Past',
      'Paid Past',
    ]);
    const all = [...body.upcoming, ...body.past];
    expect(all.map((row) => row.location)).not.toContain('Hidden Early');
    const by = Object.fromEntries(all.map((row) => [row.location, row]));

    expect(by['Up Confirmed']).toEqual({
      registrationId: upConfirmedReg,
      sessionId: upConfirmed,
      teamId: t,
      teamName: 'Foxtrot Club',
      location: 'Up Confirmed',
      address: 'Up Confirmed Road, Auckland',
      ...(await instants(upConfirmed)),
      sessionStatus: 'PUBLISHED',
      status: 'CONFIRMED',
      waitlistRank: null,
      guestCount: 1,
      withdrawalFeeDue: false,
      estimatedTotal: '24.00',
      payment: null,
    });
    expect(by['Up Waiting']).toMatchObject({
      status: 'WAITLISTED',
      waitlistRank: 2,
      guestCount: 0,
      estimatedTotal: '10.00',
      payment: null,
    });
    expect(by['Cancelled Past']).toMatchObject({
      registrationId: cancelledReg,
      sessionStatus: 'CANCELLED',
      status: 'CONFIRMED',
      estimatedTotal: '9.00',
      payment: null,
    });
    expect(by['Overdue Past']).toMatchObject({
      guestCount: 1,
      estimatedTotal: null,
      payment: {
        id: overduePayment,
        amount: '24.00',
        status: 'OVERDUE',
        billingType: 'PER_GAME',
        dueDate: '2026-09-30T00:00:00.000Z',
        paidAt: null,
        onHold: false,
        payoutBlocked: false,
      },
    });
    expect(by['Paid Past']?.payment).toMatchObject({
      id: paidPayment,
      amount: '8.00',
      status: 'PAID',
      paidAt: '2026-09-20T00:00:00.000Z',
    });
    expect(by['Late Past']).toMatchObject({
      status: 'WITHDRAWN',
      withdrawalFeeDue: true,
      estimatedTotal: null,
      payment: { id: latePayment, amount: '17.00', status: 'PENDING' },
    });
  });

  it('pages Past 20 at a time through an opaque cursor with no repeat or skip, and sends Upcoming only on the first page', async () => {
    const t = await team('Golf Club');
    const player = await httpMember(h, t);
    const upcoming = await session(t, { hours: 40, location: 'Soon', address: '1 Soon Road' });
    await insertRegistration(database.pool, {
      sessionId: upcoming,
      teamId: t,
      userId: player.userId,
    });
    const expected: string[] = [];
    for (let i = 0; i < 45; i += 1) {
      const sessionId = await session(t, {
        hours: -(24 + i * 6),
        location: `Past ${String(i).padStart(2, '0')}`,
        address: `${i} Past Road`,
      });
      await insertRegistration(database.pool, { sessionId, teamId: t, userId: player.userId });
      expected.push(sessionId);
    }

    const one = await registrationsBody(player);
    expect(one.upcoming.map((row) => row.sessionId)).toEqual([upcoming]);
    expect(one.past).toHaveLength(20);
    expect(one.nextCursor).not.toBeNull();
    const two = await registrationsBody(
      player,
      `?cursor=${encodeURIComponent(one.nextCursor as string)}`,
    );
    expect(two.upcoming).toEqual([]);
    expect(two.past).toHaveLength(20);
    expect(two.nextCursor).not.toBeNull();
    const three = await registrationsBody(
      player,
      `?cursor=${encodeURIComponent(two.nextCursor as string)}`,
    );
    expect(three.past).toHaveLength(5);
    expect(three.nextCursor).toBeNull();
    // Newest start first: the sessions were seeded from nearest to oldest.
    expect([...one.past, ...two.past, ...three.past].map((row) => row.sessionId)).toEqual(expected);

    const refused = await registrations(player, '?cursor=not-a-cursor');
    expect(refused.statusCode).toBe(422);
    expect(refused.headers['cache-control']).toBe('no-store');
  });

  it('shows an ended, unbilled CONFIRMED row in Past with an estimate and no payment, then the real payment once billed (AC-ASYNC-2)', async () => {
    const t = await team('Hotel Club');
    const player = await httpMember(h, t, { sex: 'FEMALE', skill: 'BEGINNER' });
    const ended = await session(t, {
      hours: -48,
      location: 'Ended Hall',
      address: '8 Ended Road',
      flat: '12.00',
    });
    const registrationId = await insertRegistration(database.pool, {
      sessionId: ended,
      teamId: t,
      userId: player.userId,
    });
    // A team whose payout was blocked after publishing: its payments are not payable now.
    await database.pool.query(`UPDATE teams SET payout_blocked_at = now() WHERE id = $1`, [t]);

    const before = await registrationsBody(player);
    expect(before.upcoming).toEqual([]);
    expect(before.past).toHaveLength(1);
    expect(before.past[0]).toMatchObject({
      registrationId,
      status: 'CONFIRMED',
      estimatedTotal: '12.00',
      payment: null,
    });

    const paymentId = await insertPayment(database.pool, {
      userId: player.userId,
      teamId: t,
      registrationId,
      amount: '12.00',
      dueDate: new Date('2026-10-04T00:00:00.000Z'),
    });
    const billed = (await registrationsBody(player)).past[0];
    expect(billed?.estimatedTotal).toBeNull();
    expect(billed?.payment).toMatchObject({
      id: paymentId,
      amount: '12.00',
      status: 'PENDING',
      onHold: false,
      payoutBlocked: true,
    });

    await database.pool.query(`UPDATE payments SET status = 'OVERDUE' WHERE id = $1`, [paymentId]);
    await insertPaymentAttempt(database.pool, {
      paymentId,
      amount: '12.00',
      status: 'HELD',
      akahuPaymentId: `fake_bei_1200_${START_TIME.getTime()}_hold`,
    });
    const overdue = (await registrationsBody(player)).past[0];
    expect(overdue?.payment).toMatchObject({ status: 'OVERDUE', onHold: true });
  });
});

// ---------------------------------------------------------------------------------------------
// Scoping (AC-HAPPY-7)
// ---------------------------------------------------------------------------------------------

describe('caller scoping (AC-HAPPY-7)', () => {
  it("never returns another player's rows, and counts only an APPROVED membership for open sessions", async () => {
    const a = await team('India Club');
    const b = await team('Juliet Club');
    const pending = await team('Kilo Club');
    const rejected = await team('Lima Club');
    const p1 = await httpMember(h, a, { sex: 'FEMALE' });
    const p2 = await httpMember(h, a, { sex: 'MALE', email: 'quentin.secret@example.test' });
    await join(p1.userId, b);
    await join(p2.userId, b);
    await join(p1.userId, pending, 'PENDING');
    await join(p1.userId, rejected, 'REJECTED');

    const sa = await session(a, { hours: 20, location: 'India Hall', address: '1 India Road' });
    const sb = await session(b, { hours: 21, location: 'Juliet Hall', address: '2 Juliet Road' });
    await session(pending, { hours: 22, location: 'Kilo Hall', address: '3 Kilo Road' });
    await session(rejected, { hours: 23, location: 'Lima Hall', address: '4 Lima Road' });

    // Player 2: a party with a named guest, a billed and paid game, a registration in b.
    const q = await party({ sessionId: sa, teamId: a, userId: p2.userId }, 1);
    await database.pool.query(
      `UPDATE registration_guests SET display_name = $2 WHERE registration_id = $1`,
      [q, 'Quentin Secret'],
    );
    await insertRegistration(database.pool, { sessionId: sb, teamId: b, userId: p2.userId });
    const past = await session(a, { hours: -72, location: 'Old Hall', address: '5 Old Road' });
    const pastReg = await insertRegistration(database.pool, {
      sessionId: past,
      teamId: a,
      userId: p2.userId,
    });
    const q2Payment = await insertPayment(database.pool, {
      userId: p2.userId,
      teamId: a,
      registrationId: pastReg,
      amount: '17.00',
      status: 'PAID',
    });
    // Player 1: one registration of their own.
    const mine = await insertRegistration(database.pool, {
      sessionId: sb,
      teamId: b,
      userId: p1.userId,
    });

    const sessions = await openBody(p1);
    expect(sessions.sessions.map((row) => row.sessionId).sort()).toEqual([sa, sb].sort());
    const mineList = await registrationsBody(p1);
    expect(mineList.upcoming.map((row) => row.registrationId)).toEqual([mine]);
    expect(mineList.past).toEqual([]);
    for (const text of [JSON.stringify(sessions), JSON.stringify(mineList)]) {
      for (const secret of [
        'Quentin Secret',
        'quentin.secret',
        p2.userId,
        q,
        q2Payment,
        'authorisation',
        'bank_account',
        '@',
      ]) {
        expect(text, secret).not.toContain(secret);
      }
    }
    // Player 2's own view has their party and payment.
    const theirs = await registrationsBody(p2);
    expect(theirs.past[0]?.payment?.id).toBe(q2Payment);
  });

  it('drops a team’s sessions the moment the caller is banned, while their own history stays', async () => {
    const t = await team('Mike Club');
    const player = await httpMember(h, t);
    const sessionId = await session(t, {
      hours: 30,
      location: 'Mike Hall',
      address: '7 Mike Road',
      flat: '12.00',
    });
    const registrationId = await insertRegistration(database.pool, {
      sessionId,
      teamId: t,
      userId: player.userId,
    });
    expect((await openBody(player)).sessions.map((row) => row.sessionId)).toEqual([sessionId]);

    await database.pool.query(
      `UPDATE team_members SET status = 'BANNED', banned_at = now(), banned_by = user_id
        WHERE team_id = $1 AND user_id = $2`,
      [t, player.userId],
    );
    expect((await openBody(player)).sessions).toEqual([]);
    const history = await registrationsBody(player);
    expect(history.upcoming.map((row) => row.registrationId)).toEqual([registrationId]);
  });

  it('answers 401 with no-store to a caller with no session, on registrations too', async () => {
    const response = await registrations(null);
    expect(response.statusCode).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
    const ok = await registrations(await httpMember(h, await team('November Club')));
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.json()).toEqual({ upcoming: [], past: [], nextCursor: null });
  });
});

/**
 * Team banking and GST API (Phase 2): the five routes over a real cloned Postgres, the real route guard, the real
 * keyring and a real pg-boss producer, through `app.inject`. Decisions: the task file's Creative Reconciliation
 * R1 (the payout is the account name and number only), R2 (one GST number), R3 (`payout_blocked_at`), R4 (lock
 * protocol), R7 (unreadable details) and R8 (audit columns and the change email) override the spec ACs.
 * The races hold a real team-row lock and wait for Postgres to report the blocked backends; nothing sleeps.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUEUE_NAMES, getQueue } from '../../src/jobs/registry.ts';
import { createCrypto } from '../../src/lib/crypto/crypto.ts';
import { createKeyProvider } from '../../src/lib/crypto/keyring.ts';
import { createJobRunner, type JobRunner } from '../../src/lib/jobs/jobs.ts';
import { TEST_WEB_BASE_URL } from '../helpers/app-deps.ts';
import { buildAuthTestApp, type AuthTestApp } from '../helpers/auth-app.ts';
import {
  ACCOUNT_A,
  ACCOUNT_B,
  GST_A,
  GST_B,
  bankingEmailJobs,
  createBankingScene,
  type BankingBody,
  type ErrorBody,
  type GstBody,
} from '../helpers/banking-scene.ts';
import {
  insertBilledRegistration,
  insertSession,
  insertTeamMember,
  insertUser,
} from '../helpers/factories.ts';
import { raceUnderTeamLock } from '../helpers/lock-waiters.ts';
import { captureLogs } from '../helpers/log-capture.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

const enqueueControls: { calls: number; failOnCall: number | null } = {
  calls: 0,
  failOnCall: null,
};

let database: TestDatabase;
let worker: JobRunner;
let producer: JobRunner;
let h: AuthTestApp;
let scene: ReturnType<typeof createBankingScene>;

beforeAll(async () => {
  // The racing saves need a connection per blocked request plus the lock holder.
  database = await createTestDatabase({ poolMax: 24 });
  worker = createJobRunner({
    databaseUrl: database.url,
    logger: captureLogs().logger,
    role: 'worker',
  });
  producer = createJobRunner({
    databaseUrl: database.url,
    logger: captureLogs().logger,
    role: 'producer',
  });
  await worker.start();
  await producer.start();
  // Define the queue only: nothing works it, so the jobs stay queued and inspectable.
  await worker.defineQueue(getQueue(QUEUE_NAMES.sendEmail));
  h = await buildAuthTestApp(database.pool, {
    jobs: {
      enqueue: async (queue, data, options) => {
        enqueueControls.calls += 1;
        if (enqueueControls.failOnCall === enqueueControls.calls) {
          throw new Error('enqueue failed after earlier jobs were written');
        }
        return producer.enqueue(queue, data, options);
      },
    },
  });
  scene = createBankingScene(h, database);
});
afterAll(async () => {
  await h.close();
  await producer.stop();
  await worker.stop();
  await database.close();
});

const json = <T>(response: { json: () => unknown }): T => response.json() as T;

describe('route guard (AC-ENTRY-2, AC-ERROR-14, AC-VERIFY-5)', () => {
  it('answers 401 to signed-out callers and 403 to everyone but an approved admin of this team, before the body is parsed, with no value in any body', async () => {
    const admin = await scene.person();
    const teamId = await scene.team([admin], { payoutConfigured: true });
    const otherAdmin = await scene.person();
    await scene.team([otherAdmin]);
    const players = {
      noMembership: await scene.person(),
      pending: await scene.person(),
      rejected: await scene.person(),
      banned: await scene.person(),
      member: await scene.person(),
      globalAdmin: await scene.person(),
    };
    for (const [status, who] of [
      ['PENDING', players.pending],
      ['REJECTED', players.rejected],
      ['BANNED', players.banned],
      ['APPROVED', players.member],
    ] as const) {
      await insertTeamMember(database.pool, { teamId, userId: who.id, status });
    }
    await database.pool.query(`UPDATE users SET role = 'GLOBAL_ADMIN' WHERE id = $1`, [
      players.globalAdmin.id,
    ]);

    // An invalid body proves the guard answers first: a 422 here would mean the body was parsed.
    const invalid = { definitely: 'not valid', accountName: '' };
    const requests = [
      (who: typeof admin | null) => scene.getBanking(teamId, who),
      (who: typeof admin | null) => scene.putBanking(teamId, who, invalid),
      (who: typeof admin | null) => scene.deleteBanking(teamId, who),
      (who: typeof admin | null) => scene.getGst(teamId, who),
      (who: typeof admin | null) => scene.putGst(teamId, who, invalid),
    ];
    for (const request of requests) {
      const anonymous = await request(null);
      expect(anonymous.statusCode).toBe(401);
      for (const [label, who] of [
        ['player without membership', players.noMembership],
        ['pending', players.pending],
        ['rejected', players.rejected],
        ['banned', players.banned],
        ['plain member', players.member],
        ['admin of another team', otherAdmin],
        ['global admin without membership', players.globalAdmin],
      ] as const) {
        const response = await request(who);
        expect(response.statusCode, label).toBe(403);
        expect(response.headers['cache-control'], label).toBe('no-store');
        expect(response.body, label).not.toContain('accountName');
        expect(response.body, label).not.toContain(ACCOUNT_A.last4);
      }
    }
    expect((await scene.row(teamId)).bank_account_number).not.toBeNull();
  });

  it('answers 403 for another team and for a team that does not exist, and leaves the other team untouched', async () => {
    const adminA = await scene.person();
    const adminB = await scene.person();
    const teamA = await scene.team([adminA]);
    const teamB = await scene.team([adminB], { payoutConfigured: true });
    const before = await scene.row(teamB);
    const ghost = randomUUID();
    for (const target of [teamB, ghost]) {
      expect((await scene.getBanking(target, adminA)).statusCode).toBe(403);
      expect(
        (await scene.putBanking(target, adminA, scene.body('Intruder', ACCOUNT_A))).statusCode,
      ).toBe(403);
      expect((await scene.deleteBanking(target, adminA)).statusCode).toBe(403);
      expect((await scene.getGst(target, adminA)).statusCode).toBe(403);
      expect(
        (await scene.putGst(target, adminA, { gstRegistered: true, gstNumber: GST_A.input }))
          .statusCode,
      ).toBe(403);
    }
    expect(await scene.row(teamB)).toEqual(before);
    expect((await scene.row(teamA)).bank_account_number).toBeNull();
  });

  it('answers a malformed team id with the global error body, never a 500, and leaks nothing', async () => {
    const admin = await scene.person();
    for (const target of ['not-a-uuid', '123']) {
      const response = await scene.getBanking(target, admin);
      expect([403, 404, 422]).toContain(response.statusCode);
      expect(json<ErrorBody>(response).error).toEqual(
        expect.objectContaining({ code: expect.any(String) }),
      );
    }
  });
});

describe('banking save and read (AC-HAPPY-1..4, AC-INTEGRATION-1)', () => {
  it('first save stores sealed name and number (suffix padded), the masked last 4, the audit stamp, and never touches the Akahu or IRD columns', async () => {
    const admin = await scene.person('Aroha Admin');
    const teamId = await scene.team([admin]);

    const response = await scene.putBanking(
      teamId,
      admin,
      scene.body('  Court Jesters Badminton Club  ', ACCOUNT_A),
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(json<BankingBody>(response)).toEqual({
      banking: {
        isPayoutConfigured: true,
        payoutBlocked: false,
        accountName: 'Court Jesters Badminton Club',
        unreadable: false,
        accountNumberLast4: ACCOUNT_A.last4,
        lastChanged: { at: h.clock.now().toISOString(), by: { fullName: 'Aroha Admin' } },
      },
    });

    const stored = await scene.row(teamId);
    expect(await scene.opened(teamId)).toEqual({
      name: 'Court Jesters Badminton Club',
      number: ACCOUNT_A.canonical,
    });
    expect(stored.bank_account_last4).toBe(ACCOUNT_A.last4);
    expect(stored.is_payout_configured).toBe(true);
    expect(stored.banking_updated_by).toBe(admin.id);
    expect(stored.banking_updated_at?.toISOString()).toBe(h.clock.now().toISOString());
    expect([stored.akahu_merchant_id, stored.akahu_app_token, stored.ird_number]).toEqual([
      null,
      null,
      null,
    ]);
    // Active key id on both envelopes; no readable secret anywhere in the row.
    expect(stored.bank_account_name?.startsWith('v1.dev1.')).toBe(true);
    expect(stored.bank_account_number?.startsWith('v1.dev1.')).toBe(true);
    const { rows } = await database.pool.query<{ whole: string }>(
      `SELECT t::text AS whole FROM teams t WHERE id = $1`,
      [teamId],
    );
    for (const secret of ['Court Jesters', '0068389', '01-0902']) {
      expect(rows[0]?.whole).not.toContain(secret);
    }

    const read = await scene.getBanking(teamId, admin);
    expect(read.statusCode).toBe(200);
    expect(json<BankingBody>(read).banking.accountNumberLast4).toBe(ACCOUNT_A.last4);
    expect(read.body).not.toContain('0068389');
  });

  it('keeps the saved number byte-identical when it is omitted or blank, and requires it on a first save (R2 of the journey)', async () => {
    const admin = await scene.person();
    const teamId = await scene.team([admin]);

    const first = await scene.putBanking(teamId, admin, scene.body('Club', undefined));
    expect(first.statusCode).toBe(422);
    expect(json<ErrorBody>(first).error.fieldErrors?.accountNumber).toEqual([
      'Enter the account number.',
    ]);
    expect((await scene.row(teamId)).bank_account_name).toBeNull();

    expect((await scene.putBanking(teamId, admin, scene.body('Club', ACCOUNT_A))).statusCode).toBe(
      200,
    );
    const before = await scene.row(teamId);
    for (const extra of [{}, { accountNumber: '   ' }]) {
      const renamed = await scene.putBanking(
        teamId,
        admin,
        scene.body(`Renamed ${String(Object.keys(extra).length)}`, undefined, extra),
      );
      expect(renamed.statusCode).toBe(200);
    }
    const after = await scene.row(teamId);
    expect(after.bank_account_number).toBe(before.bank_account_number);
    expect(after.bank_account_last4).toBe(before.bank_account_last4);
    expect(after.bank_account_name).not.toBe(before.bank_account_name);
    expect((await scene.opened(teamId)).name).toBe('Renamed 1');
    expect(after.is_payout_configured).toBe(true);
  });

  it('replaces the number with a new sealed value and last 4, and removes the block with its audit stamp (idempotent when nothing is stored)', async () => {
    const admin = await scene.person();
    const teamId = await scene.team([admin]);
    await scene.putBanking(teamId, admin, scene.body('Club', ACCOUNT_A));
    const before = await scene.row(teamId);

    h.clock.advance(60_000);
    const replaced = await scene.putBanking(teamId, admin, scene.body('Club', ACCOUNT_B));
    expect(replaced.statusCode).toBe(200);
    const swapped = await scene.row(teamId);
    expect(swapped.bank_account_number).not.toBe(before.bank_account_number);
    expect(swapped.bank_account_last4).toBe(ACCOUNT_B.last4);
    expect((await scene.opened(teamId)).number).toBe(ACCOUNT_B.canonical);

    h.clock.advance(60_000);
    const removed = await scene.deleteBanking(teamId, admin);
    expect(removed.statusCode).toBe(200);
    expect(removed.headers['cache-control']).toBe('no-store');
    expect(json<BankingBody>(removed).banking).toMatchObject({
      isPayoutConfigured: false,
      accountName: null,
      accountNumberLast4: null,
      lastChanged: { by: { fullName: admin.fullName } },
    });
    const empty = await scene.row(teamId);
    expect([
      empty.bank_account_name,
      empty.bank_account_number,
      empty.bank_account_last4,
      empty.payout_blocked_at,
    ]).toEqual([null, null, null, null]);
    expect(empty.is_payout_configured).toBe(false);
    expect(empty.banking_updated_by).toBe(admin.id);
    expect(empty.banking_updated_at?.toISOString()).toBe(h.clock.now().toISOString());

    // Nothing stored: a second removal is a harmless no-op that leaves the stamp alone.
    h.clock.advance(60_000);
    expect((await scene.deleteBanking(teamId, admin)).statusCode).toBe(200);
    expect((await scene.row(teamId)).banking_updated_at?.toISOString()).toBe(
      empty.banking_updated_at?.toISOString(),
    );
  });

  it('refuses removal with 409 banking_in_use while a paid session is published, allows a replacement, and allows removal once it completes (R4)', async () => {
    const admin = await scene.person();
    const teamId = await scene.team([admin], { payoutConfigured: true });
    const sessionId = await insertSession(database.pool, teamId);
    await database.pool.query(`UPDATE game_sessions SET status = 'PUBLISHED' WHERE id = $1`, [
      sessionId,
    ]);
    const before = await scene.row(teamId);

    const refused = await scene.deleteBanking(teamId, admin);
    expect(refused.statusCode).toBe(409);
    expect(json<ErrorBody>(refused).error.code).toBe('banking_in_use');
    expect(await scene.row(teamId)).toEqual(before);

    expect((await scene.putBanking(teamId, admin, scene.body('Club', ACCOUNT_B))).statusCode).toBe(
      200,
    );
    await database.pool.query(`UPDATE game_sessions SET status = 'COMPLETED' WHERE id = $1`, [
      sessionId,
    ]);
    expect((await scene.deleteBanking(teamId, admin)).statusCode).toBe(200);
    expect((await scene.row(teamId)).is_payout_configured).toBe(false);
  });

  it('clears payout_blocked_at on a save, even one that changes nothing, and on removal; GET reports payoutBlocked (AC-ERROR-15, R3)', async () => {
    const admin = await scene.person();
    const teamId = await scene.team([admin]);
    await scene.putBanking(teamId, admin, scene.body('Club', ACCOUNT_A));
    await database.pool.query(`UPDATE teams SET payout_blocked_at = now() WHERE id = $1`, [teamId]);

    const blocked = json<BankingBody>(await scene.getBanking(teamId, admin)).banking;
    expect(blocked).toMatchObject({ payoutBlocked: true, isPayoutConfigured: false });
    expect(blocked.accountNumberLast4).toBe(ACCOUNT_A.last4);

    const resaved = await scene.putBanking(teamId, admin, scene.body('Club', ACCOUNT_A));
    expect(json<BankingBody>(resaved).banking).toMatchObject({
      payoutBlocked: false,
      isPayoutConfigured: true,
    });
    expect((await scene.row(teamId)).payout_blocked_at).toBeNull();

    await database.pool.query(`UPDATE teams SET payout_blocked_at = now() WHERE id = $1`, [teamId]);
    expect((await scene.deleteBanking(teamId, admin)).statusCode).toBe(200);
    expect((await scene.row(teamId)).payout_blocked_at).toBeNull();
  });
});

describe('validation (AC-ERROR-1..5, AC-VERIFY-3)', () => {
  it('reports every failing banking field with the copy deck, never echoes the input, and writes nothing', async () => {
    const admin = await scene.person();
    const teamId = await scene.team([admin], { payoutConfigured: true });
    const before = await scene.row(teamId);
    const typed = '99-9999-9999999-99';

    const failing = [
      [{ ...scene.body('', ACCOUNT_A) }, 'accountName', 'Enter the name on the bank account.'],
      [
        { ...scene.body('x'.repeat(101), ACCOUNT_A) },
        'accountName',
        'Use 100 characters or fewer.',
      ],
      [
        { ...scene.body('Club', ACCOUNT_A), accountNumber: '12-34-56' },
        'accountNumber',
        'Enter an NZ account number in the format 00-0000-0000000-00.',
      ],
      [
        { ...scene.body('Club', ACCOUNT_A), accountNumber: typed },
        'accountNumber',
        'That bank or branch number is not recognised. Check the number and try again.',
      ],
      [
        { ...scene.body('Club', ACCOUNT_A), accountNumber: '01-0902-0068388-00' },
        'accountNumber',
        'That account number does not look right. Check the digits and try again.',
      ],
      [{ ...scene.body('Club', ACCOUNT_A), changeKey: 'nope' }, 'changeKey', undefined],
    ] as const;
    for (const [payload, field, message] of failing) {
      const response = await scene.putBanking(teamId, admin, payload);
      expect(response.statusCode, field).toBe(422);
      const { error } = json<ErrorBody>(response);
      expect(error.code).toBe('validation_failed');
      expect(error.fieldErrors?.[field]).toBeDefined();
      if (message !== undefined) expect(error.fieldErrors?.[field]).toEqual([message]);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toContain(typed);
      expect(response.body).not.toContain('01-0902-0068388');
    }

    // All failing fields come back together.
    const together = await scene.putBanking(teamId, admin, {
      accountName: '',
      accountNumber: '1',
      changeKey: 'x',
    });
    expect(Object.keys(json<ErrorBody>(together).error.fieldErrors ?? {}).sort()).toEqual([
      'accountName',
      'accountNumber',
      'changeKey',
    ]);
    expect(await scene.row(teamId)).toEqual(before);
  });

  it('rejects server-owned and unknown keys on both PUTs with a _form error that does not name the key', async () => {
    const admin = await scene.person();
    const teamId = await scene.team([admin], { payoutConfigured: true });
    const before = await scene.row(teamId);
    for (const key of ['isPayoutConfigured', 'teamId', 'role', 'bankAccountLast4', 'whatever']) {
      const banking = await scene.putBanking(
        teamId,
        admin,
        scene.body('Club', ACCOUNT_B, { [key]: true }),
      );
      expect(banking.statusCode, key).toBe(422);
      expect(json<ErrorBody>(banking).error.fieldErrors?._form, key).toBeDefined();
      expect(banking.body).not.toContain(key);
      const gst = await scene.putGst(teamId, admin, {
        gstRegistered: false,
        [key]: true,
      });
      expect(gst.statusCode, key).toBe(422);
      expect(gst.body).not.toContain(key);
    }
    expect(await scene.row(teamId)).toEqual(before);
  });

  it('keeps secrets out of every body: no full number (with or without hyphens) and no ciphertext in any response of any status', async () => {
    const admin = await scene.person();
    const member = await scene.person();
    const teamId = await scene.team([admin]);
    await insertTeamMember(database.pool, { teamId, userId: member.id });
    const sessionId = await insertSession(database.pool, teamId);
    const bodies: string[] = [];
    const keep = <T extends { body: string }>(response: T): T => {
      bodies.push(response.body);
      return response;
    };
    keep(await scene.putBanking(teamId, admin, scene.body('Club', ACCOUNT_A)));
    keep(await scene.getBanking(teamId, admin));
    keep(await scene.putBanking(teamId, admin, scene.body('', ACCOUNT_A)));
    keep(await scene.getBanking(teamId, member));
    await database.pool.query(`UPDATE game_sessions SET status = 'PUBLISHED' WHERE id = $1`, [
      sessionId,
    ]);
    expect(keep(await scene.deleteBanking(teamId, admin)).statusCode).toBe(409);
    const stored = await scene.row(teamId);
    const secrets = [
      ACCOUNT_A.input,
      ACCOUNT_A.canonical,
      ACCOUNT_A.canonical.replaceAll('-', ''),
      '0068389',
      stored.bank_account_number ?? 'missing',
      stored.bank_account_name ?? 'missing',
    ];
    for (const body of bodies) {
      for (const secret of secrets) expect(body).not.toContain(secret);
    }
  });
});

describe('GST (AC-HAPPY-5, AC-HAPPY-6, AC-ERROR-6, AC-ERROR-7, R2)', () => {
  it('registers with a hyphenated number stored as digits, keeps the number when turned off, never writes ird_number, and leaves payments alone', async () => {
    const admin = await scene.person();
    const teamId = await scene.team([admin], { payoutConfigured: true });
    const sessionId = await insertSession(database.pool, teamId);
    const billed = await insertBilledRegistration(database.pool, teamId, sessionId);
    const paymentSnapshot = async () =>
      (
        await database.pool.query(
          `SELECT gst_registered, gst_rate_bps, gst_amount, subtotal_amount, amount FROM payments WHERE id = $1`,
          [billed.paymentId],
        )
      ).rows[0] as Record<string, unknown>;
    const paymentBefore = await paymentSnapshot();

    expect(json<GstBody>(await scene.getGst(teamId, admin)).gst).toEqual({
      gstRegistered: false,
      gstNumber: null,
    });
    const on = await scene.putGst(teamId, admin, { gstRegistered: true, gstNumber: GST_A.input });
    expect(on.statusCode).toBe(200);
    expect(on.headers['cache-control']).toBe('no-store');
    expect(json<GstBody>(on).gst).toEqual({ gstRegistered: true, gstNumber: GST_A.canonical });

    const off = await scene.putGst(teamId, admin, { gstRegistered: false });
    expect(json<GstBody>(off).gst).toEqual({ gstRegistered: false, gstNumber: GST_A.canonical });
    const backOn = await scene.putGst(teamId, admin, { gstRegistered: true });
    expect(json<GstBody>(backOn).gst).toEqual({ gstRegistered: true, gstNumber: GST_A.canonical });
    const replaced = await scene.putGst(teamId, admin, {
      gstRegistered: true,
      gstNumber: GST_B.input,
    });
    expect(json<GstBody>(replaced).gst.gstNumber).toBe(GST_B.canonical);

    const stored = await scene.row(teamId);
    expect(stored).toMatchObject({ gst_registered: true, gst_number: GST_B.canonical });
    expect(stored.ird_number).toBeNull();
    expect(await paymentSnapshot()).toEqual(paymentBefore);
    // GST writes never move the banking block or its audit stamp.
    expect(stored.banking_updated_at).toBeNull();
    expect(stored.is_payout_configured).toBe(true);
  });

  it('refuses registration without a number and malformed numbers per field, and writes nothing', async () => {
    const admin = await scene.person();
    const teamId = await scene.team([admin]);
    const before = await scene.row(teamId);

    const missing = await scene.putGst(teamId, admin, { gstRegistered: true });
    expect(missing.statusCode).toBe(422);
    expect(json<ErrorBody>(missing).error.fieldErrors?.gstNumber).toEqual([
      'Enter your GST number to register for GST.',
    ]);
    const short = await scene.putGst(teamId, admin, { gstRegistered: true, gstNumber: '1234567' });
    expect(json<ErrorBody>(short).error.fieldErrors?.gstNumber).toEqual([
      'Enter an 8 or 9 digit GST number.',
    ]);
    const badCheck = await scene.putGst(teamId, admin, {
      gstRegistered: true,
      gstNumber: '49-091-851',
    });
    expect(json<ErrorBody>(badCheck).error.fieldErrors?.gstNumber).toEqual([
      'That GST number does not look right. Check the digits and try again.',
    ]);
    for (const response of [missing, short, badCheck]) {
      expect(response.body).not.toContain('49-091-851');
      expect(response.body).not.toContain('1234567');
    }
    expect(await scene.row(teamId)).toEqual(before);
  });
});

describe('locking (AC-ERROR-11, R4)', () => {
  it('refuses a demoted admin with 403 under the team lock and writes nothing', async () => {
    const actor = await scene.person();
    const other = await scene.person();
    const teamId = await scene.team([actor, other]);
    const [outcome] = await raceUnderTeamLock(
      database.pool,
      teamId,
      [() => scene.putBanking(teamId, actor, scene.body('Club', ACCOUNT_A))],
      {
        beforeRelease: async (lock) => {
          await lock.query(
            `UPDATE team_members SET role = 'MEMBER' WHERE team_id = $1 AND user_id = $2`,
            [teamId, actor.id],
          );
        },
      },
    );
    expect(outcome?.statusCode).toBe(403);
    expect((await scene.row(teamId)).bank_account_number).toBeNull();
    // One refusal event for the stale admin, not one from the service and one from the global error hook.
    const refusals = h.logs
      .lines()
      .filter(
        (l) => l.event === 'team.action.refused' && l.actorId === actor.id && l.teamId === teamId,
      );
    expect(refusals).toHaveLength(1);
  });

  it('serialises two admins saving at once: the final row is wholly one submission, never a mix of fields', async () => {
    const first = await scene.person();
    const second = await scene.person();
    const teamId = await scene.team([first, second]);
    const results = await raceUnderTeamLock(database.pool, teamId, [
      () => scene.putBanking(teamId, first, scene.body('Name One', ACCOUNT_A)),
      () => scene.putBanking(teamId, second, scene.body('Name Two', ACCOUNT_B)),
    ]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    const stored = await scene.opened(teamId);
    const one = { name: 'Name One', number: ACCOUNT_A.canonical };
    const two = { name: 'Name Two', number: ACCOUNT_B.canonical };
    expect([one, two]).toContainEqual(stored);
    const last4 = (await scene.row(teamId)).bank_account_last4;
    expect(last4).toBe(stored.number === ACCOUNT_A.canonical ? ACCOUNT_A.last4 : ACCOUNT_B.last4);
  });
});

describe('unreadable details and key rotation (AC-ERROR-12, AC-VERIFY-10, R7)', () => {
  it('answers 200 with unreadable true when the stored name cannot be decrypted, and a full save restores it', async () => {
    const admin = await scene.person();
    const teamId = await scene.team([admin]);
    await scene.putBanking(teamId, admin, scene.body('Club', ACCOUNT_A));
    // Sealed for another row: valid shape, fails authentication.
    const foreign = scene.crypto.encrypt('Someone Else', {
      table: 'teams',
      column: 'bank_account_name',
      rowId: randomUUID(),
    });
    await database.pool.query(`UPDATE teams SET bank_account_name = $2 WHERE id = $1`, [
      teamId,
      foreign,
    ]);

    const read = await scene.getBanking(teamId, admin);
    expect(read.statusCode).toBe(200);
    expect(json<BankingBody>(read).banking).toMatchObject({
      accountName: null,
      unreadable: true,
      accountNumberLast4: ACCOUNT_A.last4,
    });
    expect(read.body).not.toContain('Someone Else');
    const logged = h.logs.lines().filter((l) => l.event === 'team.banking.decrypt_failed');
    expect(logged.some((l) => l.teamId === teamId && l.reason === 'auth_failed')).toBe(true);

    const restored = await scene.putBanking(teamId, admin, scene.body('Club Again', ACCOUNT_A));
    expect(restored.statusCode).toBe(200);
    expect(json<BankingBody>(restored).banking).toMatchObject({
      accountName: 'Club Again',
      unreadable: false,
    });
  });

  it('answers 422 accountNumberRequired when the stored number is unreadable and the save omits it, and a full save replaces the block (R7)', async () => {
    const admin = await scene.person();
    const teamId = await scene.team([admin]);
    await scene.putBanking(teamId, admin, scene.body('Club', ACCOUNT_A));
    const foreign = scene.crypto.encrypt('0000000000000', {
      table: 'teams',
      column: 'bank_account_number',
      rowId: randomUUID(),
    });
    await database.pool.query(`UPDATE teams SET bank_account_number = $2 WHERE id = $1`, [
      teamId,
      foreign,
    ]);
    const before = (await scene.row(teamId)).bank_account_number;

    const refused = await scene.putBanking(teamId, admin, scene.body('Club Renamed', undefined));
    expect(refused.statusCode).toBe(422);
    expect(refused.body).toContain('accountNumber');
    expect((await scene.row(teamId)).bank_account_number).toBe(before);

    const full = await scene.putBanking(teamId, admin, scene.body('Club Renamed', ACCOUNT_B));
    expect(full.statusCode).toBe(200);
    expect(await scene.opened(teamId)).toEqual({
      name: 'Club Renamed',
      number: ACCOUNT_B.canonical,
    });
    expect(json<BankingBody>(full).banking.unreadable).toBe(false);
  });

  it('reads rows sealed with an older key and seals new writes with the active one', async () => {
    const rotated = await buildAuthTestApp(database.pool, {
      env: {
        ENCRYPTION_KEYS: `dev1:${Buffer.alloc(32, 1).toString('base64')},dev2:${Buffer.alloc(32, 2).toString('base64')}`,
        ENCRYPTION_ACTIVE_KEY_ID: 'dev2',
      },
    });
    try {
      const oldCrypto = createCrypto(
        createKeyProvider([{ id: 'dev1', key: Buffer.alloc(32, 1) }], 'dev1'),
      );
      const rotatedScene = createBankingScene(
        rotated,
        database,
        createCrypto(
          createKeyProvider(
            [
              { id: 'dev1', key: Buffer.alloc(32, 1) },
              { id: 'dev2', key: Buffer.alloc(32, 2) },
            ],
            'dev2',
          ),
        ),
      );
      const admin = await rotatedScene.person();
      const teamId = await rotatedScene.team([admin], { payoutConfigured: true });
      // The factory seals with its own throwaway key; write dev1 envelopes the way the old deployment did.
      await database.pool.query(
        `UPDATE teams SET bank_account_name = $2, bank_account_number = $3 WHERE id = $1`,
        [
          teamId,
          oldCrypto.encrypt('Old Key Club', {
            table: 'teams',
            column: 'bank_account_name',
            rowId: teamId,
          }),
          oldCrypto.encrypt(ACCOUNT_A.canonical, {
            table: 'teams',
            column: 'bank_account_number',
            rowId: teamId,
          }),
        ],
      );
      const read = await rotatedScene.getBanking(teamId, admin);
      expect(json<BankingBody>(read).banking).toMatchObject({
        accountName: 'Old Key Club',
        unreadable: false,
      });
      const before = await rotatedScene.row(teamId);
      expect(before.bank_account_name?.startsWith('v1.dev1.')).toBe(true);

      const saved = await rotatedScene.putBanking(
        teamId,
        admin,
        rotatedScene.body('New Key Club', ACCOUNT_B),
      );
      expect(saved.statusCode).toBe(200);
      const after = await rotatedScene.row(teamId);
      expect(after.bank_account_name?.startsWith('v1.dev2.')).toBe(true);
      expect(after.bank_account_number?.startsWith('v1.dev2.')).toBe(true);
      expect((await rotatedScene.opened(teamId)).number).toBe(ACCOUNT_B.canonical);
    } finally {
      await rotated.close();
    }
  });
});

describe('change notification (AC-ASYNC-1 as MUST, R8)', () => {
  it('enqueues one sealed email per approved admin, the actor included, with no account name or digits, and replays enqueue nothing new', async () => {
    const actor = await scene.person('Hana Actor');
    const colleague = await scene.person('Kiri Colleague');
    const teamId = await scene.team([actor, colleague], { name: 'Notified Team' });
    const payload = scene.body('Secret Account Holder Ltd', ACCOUNT_A);

    expect((await scene.putBanking(teamId, actor, payload)).statusCode).toBe(200);
    const jobs = await bankingEmailJobs(database, teamId);
    expect(jobs.map((j) => j.singleton_key).sort()).toEqual(
      [actor.id, colleague.id]
        .map((id) => `notify:banking-changed:${teamId}:${String(payload.changeKey)}:${id}`)
        .sort(),
    );
    const everything = JSON.stringify(jobs.map((j) => j.data));
    for (const secret of ['Secret Account Holder', '0068389', '8389', actor.email]) {
      expect(everything, secret).not.toContain(secret);
    }
    const forColleague = jobs.find((j) => j.singleton_key?.endsWith(`:${colleague.id}`));
    const data = forColleague?.data as { idempotencyKey: string; sealed: string };
    expect(
      Object.keys(data)
        .filter((k) => k !== '_meta')
        .sort(),
    ).toEqual(['idempotencyKey', 'sealed']);
    const message = JSON.parse(
      scene.crypto.decrypt(data.sealed, {
        table: 'pgboss.job',
        column: 'data.send-email',
        rowId: data.idempotencyKey,
      }),
    ) as { to: string; subject: string; text: string };
    expect(message.to).toBe(colleague.email);
    expect(message.text).toContain('Hana Actor');
    expect(message.text).toContain(`${TEST_WEB_BASE_URL}/teams/${teamId}/manage/banking`);
    expect(message.text).toContain('Notified Team');
    for (const secret of ['Secret Account Holder', '0068389', '8389']) {
      expect(message.text + message.subject, secret).not.toContain(secret);
    }

    // The same changeKey again, and a new key with identical values: nothing is written or enqueued.
    const stamp = (await scene.row(teamId)).banking_updated_at?.toISOString();
    h.clock.advance(60_000);
    expect((await scene.putBanking(teamId, actor, payload)).statusCode).toBe(200);
    expect(
      (await scene.putBanking(teamId, actor, scene.body('Secret Account Holder Ltd', ACCOUNT_A)))
        .statusCode,
    ).toBe(200);
    expect(await bankingEmailJobs(database, teamId)).toHaveLength(2);
    expect((await scene.row(teamId)).banking_updated_at?.toISOString()).toBe(stamp);

    // A GST change sends nothing; a removal notifies both admins again.
    await scene.putGst(teamId, actor, { gstRegistered: true, gstNumber: GST_A.input });
    expect(await bankingEmailJobs(database, teamId)).toHaveLength(2);
    expect((await scene.deleteBanking(teamId, actor)).statusCode).toBe(200);
    expect(await bankingEmailJobs(database, teamId)).toHaveLength(4);
  });

  it("treats a delayed replay of a committed change key as already applied: another admin's later save stays, and no second email goes out (D-54)", async () => {
    const first = await scene.person();
    const second = await scene.person();
    const teamId = await scene.team([first, second]);
    const original = scene.body('Name One', ACCOUNT_A);
    expect((await scene.putBanking(teamId, first, original)).statusCode).toBe(200);
    expect(
      (await scene.putBanking(teamId, second, scene.body('Name Two', ACCOUNT_B))).statusCode,
    ).toBe(200);
    const jobsBefore = await bankingEmailJobs(database, teamId);
    expect(jobsBefore).toHaveLength(4);

    // The first request is retried late, after the other admin changed the account.
    const replay = await scene.putBanking(teamId, first, original);
    expect(replay.statusCode).toBe(200);
    expect(json<BankingBody>(replay).banking.accountName).toBe('Name Two');
    expect(await scene.opened(teamId)).toEqual({ name: 'Name Two', number: ACCOUNT_B.canonical });
    expect(await bankingEmailJobs(database, teamId)).toHaveLength(4);

    // Reusing the last committed key with different values is the same operation: nothing is written or sent.
    const lastKey = (
      await database.pool.query<{ key: string }>(
        `SELECT banking_change_keys[cardinality(banking_change_keys)] AS key FROM teams WHERE id = $1`,
        [teamId],
      )
    ).rows[0]?.key;
    const reused = scene.body('Name Three', ACCOUNT_A, { changeKey: lastKey });
    expect((await scene.putBanking(teamId, first, reused)).statusCode).toBe(200);
    expect(await scene.opened(teamId)).toEqual({ name: 'Name Two', number: ACCOUNT_B.canonical });
    expect(await bankingEmailJobs(database, teamId)).toHaveLength(4);
  });

  it('rolls the whole save back, leaving no job and no change, when an enqueue fails after an earlier job was written', async () => {
    const actor = await scene.person();
    const colleague = await scene.person();
    const teamId = await scene.team([actor, colleague]);
    enqueueControls.failOnCall = enqueueControls.calls + 2;
    try {
      const response = await scene.putBanking(teamId, actor, scene.body('Club', ACCOUNT_A));
      expect(response.statusCode).toBe(500);
    } finally {
      enqueueControls.failOnCall = null;
    }
    expect(await bankingEmailJobs(database, teamId)).toHaveLength(0);
    const stored = await scene.row(teamId);
    expect([stored.bank_account_name, stored.banking_updated_at]).toEqual([null, null]);
  });
});

describe('audit display (R8)', () => {
  it('shows lastChanged.by null once the updating account is deleted', async () => {
    const admin = await scene.person();
    const teamId = await scene.team([admin]);
    await scene.putBanking(teamId, admin, scene.body('Club', ACCOUNT_A));
    const stranger = await insertUser(database.pool);
    await database.pool.query(`UPDATE teams SET banking_updated_by = $2 WHERE id = $1`, [
      teamId,
      stranger,
    ]);
    await database.pool.query(`DELETE FROM users WHERE id = $1`, [stranger]);
    const read = json<BankingBody>(await scene.getBanking(teamId, admin));
    expect(read.banking.lastChanged?.by).toBeNull();
  });
});

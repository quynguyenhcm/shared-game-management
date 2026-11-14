/**
 * Invoice downloads over HTTP on a real PostgreSQL (tax-invoices-and-exports Phase 3; AC-ENTRY-1, 3, AC-HAPPY-1, 2, 3, AC-ERROR-1,
 * 2, 5, 6, AC-ASYNC-1, AC-VERIFY-1, 4, 6, AC-INTEGRATION-1). The PDF is parsed back to text with `unpdf`. A download before the
 * issuance job has run issues on demand through the single SQL issuer; no number is consumed for a payment that is not PAID above
 * $0.00 or for a caller who may not see it. Money rows are inserted directly (the fake adapter and the job are Phase 2's tests).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { extractText, getDocumentProxy } from 'unpdf';
import type { MyPaymentsResponse, PaymentResponse } from '@sgm/shared';
import { AppError } from '../../src/lib/http/errors.ts';
import { createInvoiceService } from '../../src/modules/invoices/service.ts';
import { loadInvoiceFonts } from '../../src/modules/invoices/render-pdf.ts';
import { bearer, buildAuthTestApp, type AuthTestApp } from '../helpers/auth-app.ts';
import {
  insertAuthSession,
  insertGuest,
  insertPayment,
  insertPaymentAttempt,
  insertPublishedSession,
  insertRegistration,
  insertTeam,
  insertTeamMember,
  insertUser,
  issueDocument,
} from '../helpers/factories.ts';
import { errorOf } from '../helpers/registrations-http.ts';
import { createTestDatabase, inTransaction, type TestDatabase } from '../helpers/test-db.ts';

const BASE = new Date('2026-11-10T00:00:00.000Z');
const DAY = 86_400_000;
const GST_NUMBER = '49091850';

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
  h.clock.set(BASE);
});

// ---------------------------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------------------------

interface Person {
  readonly userId: string;
  readonly token: string;
}

async function person(
  teamId: string | null,
  role: 'TEAM_ADMIN' | 'MEMBER' | null,
  fullName?: string,
): Promise<Person> {
  const userId = await insertUser(database.pool);
  if (fullName !== undefined) {
    await database.pool.query('UPDATE users SET full_name = $2 WHERE id = $1', [userId, fullName]);
  }
  if (teamId !== null && role !== null) {
    await insertTeamMember(database.pool, { teamId, userId, role });
  }
  const { token } = await insertAuthSession(database.pool, userId, {
    createdAt: h.clock.now(),
    idleDays: 90,
    absoluteDays: 180,
  });
  return { userId, token };
}

interface Scene {
  readonly teamId: string;
  readonly sessionId: string;
  readonly admin: Person;
}

async function scene(options: { teamName?: string; gst?: boolean } = {}): Promise<Scene> {
  const gst = options.gst ?? true;
  const teamId = await insertTeam(database.pool, {
    name: options.teamName ?? 'Hōkio Badminton Club',
    payoutConfigured: true,
    gstRegistered: gst,
    ...(gst ? { gstNumber: GST_NUMBER } : {}),
  });
  const { sessionId } = await insertPublishedSession(database.pool, teamId, {
    now: new Date(BASE.getTime() - 5 * DAY),
    flat: '23.00',
  });
  await database.pool.query(
    "UPDATE game_sessions SET location = 'Hōkio Sports Hall' WHERE id = $1",
    [sessionId],
  );
  return { teamId, sessionId, admin: await person(teamId, 'TEAM_ADMIN') };
}

interface PaymentOptions {
  readonly amount?: string;
  readonly status?: 'PENDING' | 'PAID' | 'OVERDUE';
  readonly gst?: boolean;
  readonly lateWithdrawal?: boolean;
  /** A registrant fee and a guest fee that make up `amount` (the total). */
  readonly guest?: { readonly registrant: string; readonly guest: string };
  readonly payer?: Person;
  readonly payerName?: string;
  /** Another session of the team (a payer has one registration per session). */
  readonly sessionId?: string;
}

/** A payment of `scene`'s team owed by a (new) team member; PAID by default, with an amount of $23.00. */
async function payment(
  s: Scene,
  options: PaymentOptions = {},
): Promise<{ paymentId: string; payer: Person }> {
  const gst = options.gst ?? true;
  const payer =
    options.payer ?? (await person(s.teamId, 'MEMBER', options.payerName ?? 'Aroha Ngata'));
  const split = options.guest;
  const amount = options.amount ?? '23.00';
  const { registrationId, lines } = await inTransaction(database.pool, async (client) => {
    const id = await insertRegistration(client, {
      sessionId: options.sessionId ?? s.sessionId,
      teamId: s.teamId,
      userId: payer.userId,
      ...(options.lateWithdrawal === true
        ? { status: 'WITHDRAWN' as const, withdrawalFeeDue: true }
        : {}),
      ...(split === undefined ? {} : { guestCount: 1 }),
    });
    if (split === undefined) return { registrationId: id, lines: undefined };
    const guestId = await insertGuest(client, id, 1);
    return {
      registrationId: id,
      lines: [
        {
          position: 0,
          basis: 'FLAT',
          sex: 'MALE' as const,
          skill: 'BEGINNER' as const,
          unitFee: split.registrant,
        },
        {
          position: 1,
          basis: 'FLAT',
          sex: 'FEMALE' as const,
          skill: 'INTERMEDIATE' as const,
          unitFee: split.guest,
          guestId,
        },
      ],
    };
  });
  const paymentId = await insertPayment(database.pool, {
    userId: payer.userId,
    teamId: s.teamId,
    registrationId,
    amount,
    gstRegistered: gst,
    gstNumber: GST_NUMBER,
    status: options.status ?? 'PAID',
    paidAt: new Date(BASE.getTime() - DAY),
    dueDate: new Date(BASE.getTime() + 2 * DAY),
    ...(lines === undefined ? {} : { lines }),
  });
  return { paymentId, payer };
}

const asPayer = (who: Person | null, paymentId: string): Promise<LightMyRequestResponse> =>
  h.app.inject({
    method: 'GET',
    url: `/payments/${paymentId}/invoice`,
    ...(who === null ? {} : { headers: bearer(who.token) }),
  });
const asTeam = (
  who: Person | null,
  teamId: string,
  paymentId: string,
): Promise<LightMyRequestResponse> =>
  h.app.inject({
    method: 'GET',
    url: `/teams/${teamId}/payments/${paymentId}/invoice`,
    ...(who === null ? {} : { headers: bearer(who.token) }),
  });

async function textOf(res: LightMyRequestResponse): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(res.rawPayload));
  const { text } = await extractText(pdf, { mergePages: true });
  return text.replace(/\s+/g, ' ').trim();
}

async function documentCount(teamId: string): Promise<number> {
  const { rows } = await database.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM payment_documents d JOIN payments p ON p.id = d.payment_id WHERE p.team_id = $1`,
    [teamId],
  );
  return Number(rows[0]?.n ?? '0');
}

async function lastNumbers(teamId: string): Promise<Record<string, number>> {
  const { rows } = await database.pool.query<{ document_kind: string; last_number: number }>(
    'SELECT document_kind, last_number FROM team_invoice_counters WHERE team_id = $1',
    [teamId],
  );
  return Object.fromEntries(rows.map((row) => [row.document_kind, row.last_number]));
}

// ---------------------------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------------------------

describe('the payer downloads a tax invoice', () => {
  it('answers 200 with an attachment PDF, no-store, issuing INV-000001 on demand, with the stored figures (AC-HAPPY-1, AC-ASYNC-1)', async () => {
    const s = await scene();
    const { paymentId, payer } = await payment(s);
    expect(await documentCount(s.teamId)).toBe(0);

    const res = await asPayer(payer, paymentId);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="tax-invoice-INV-000001.pdf"',
    );
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(Number(res.headers['content-length'])).toBe(res.rawPayload.length);
    expect(res.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const text = await textOf(res);
    for (const expected of [
      'Tax invoice',
      'INV-000001',
      'Hōkio Badminton Club',
      'GST number 49-091-850',
      'Aroha Ngata',
      'Hōkio Sports Hall',
      'Game fee, player',
      'Subtotal (excluding GST) $20.00',
      'GST (15%) $3.00',
      'Total (including GST) $23.00',
    ]) {
      expect(text).toContain(expected);
    }
    // No email address, bank digits or Akahu reference ever reaches the document.
    expect(text).not.toMatch(/@|akahu|SGM[0-9A-Z]{8}|\b[0-9]{2}-[0-9]{4}-[0-9]{7}-[0-9]{2}\b/i);
    expect(await lastNumbers(s.teamId)).toEqual({ TAX_INVOICE: 1 });

    const downloaded = h.logs.lines().filter((line) => line.event === 'invoice.downloaded');
    expect(downloaded.at(-1)).toMatchObject({
      paymentId,
      teamId: s.teamId,
      actorRole: 'payer',
      documentKind: 'TAX_INVOICE',
      issuedOnDemand: true,
    });
    // Ids, role and kind only: no name, amount or document number in the log line.
    expect(JSON.stringify(downloaded.at(-1))).not.toMatch(/Aroha|Hōkio|23\.00|INV-0/);
  });

  it('returns the same number, date and bytes on every re-download, consuming one number (AC-HAPPY-4)', async () => {
    const s = await scene();
    const { paymentId, payer } = await payment(s);
    const first = await asPayer(payer, paymentId);
    const second = await asPayer(payer, paymentId);
    expect(second.rawPayload.equals(first.rawPayload)).toBe(true);
    expect(await lastNumbers(s.teamId)).toEqual({ TAX_INVOICE: 1 });
    const again = h.logs
      .lines()
      .filter((line) => line.event === 'invoice.downloaded')
      .at(-1);
    expect(again).toMatchObject({ issuedOnDemand: false });
  });

  it('downloads a document the job already issued without issuing again', async () => {
    const s = await scene();
    const { paymentId, payer } = await payment(s);
    expect((await issueDocument(database.pool, paymentId)).numberDisplay).toBe('INV-000001');
    const res = await asPayer(payer, paymentId);
    expect(res.headers['content-disposition']).toContain('INV-000001');
    expect(await lastNumbers(s.teamId)).toEqual({ TAX_INVOICE: 1 });
  });

  it('prints GST once for a registrant plus a guest, adding up to the stored totals (AC-HAPPY-2)', async () => {
    const s = await scene();
    const { paymentId, payer } = await payment(s, {
      amount: '37.00',
      guest: { registrant: '17.00', guest: '20.00' },
    });
    const text = await textOf(await asPayer(payer, paymentId));
    for (const expected of [
      'Game fee, player $17.00',
      'Game fee, guest 1 $20.00',
      'Subtotal (excluding GST) $32.17',
      'GST (15%) $4.83',
      'Total (including GST) $37.00',
    ]) {
      expect(text).toContain(expected);
    }
  });

  it('words a late-withdrawal fee as what it is (AC-ERROR-6)', async () => {
    const s = await scene();
    const { paymentId, payer } = await payment(s, { lateWithdrawal: true });
    const text = await textOf(await asPayer(payer, paymentId));
    expect(text).toMatch(/Late withdrawal fee, Hōkio Sports Hall, \d{1,2} [A-Z][a-z]+ \d{4}/);
  });

  it('gives a non-registered team a numbered Receipt from its own series, with no GST wording (AC-HAPPY-3)', async () => {
    const s = await scene({ gst: false, teamName: 'Whangārei Shuttlers' });
    const { paymentId, payer } = await payment(s, { gst: false, payerName: 'Tāne Wīremu' });
    const res = await asPayer(payer, paymentId);
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="receipt-RCT-000001.pdf"',
    );
    const text = await textOf(res);
    expect(text).toContain('Receipt');
    expect(text).toContain('Whangārei Shuttlers');
    expect(text).toContain('Tāne Wīremu');
    expect(text).toContain('Total paid $23.00');
    expect(text).not.toMatch(/tax|gst|including|excluding/i);
    expect(await lastNumbers(s.teamId)).toEqual({ RECEIPT: 1 });
  });

  it('keeps an issued document exactly as issued after the team, the payer or the registration change (AC-VERIFY-4)', async () => {
    const s = await scene();
    const { paymentId, payer } = await payment(s);
    const before = await asPayer(payer, paymentId);
    await database.pool.query("UPDATE teams SET name = 'Renamed Club' WHERE id = $1", [s.teamId]);
    await database.pool.query("UPDATE users SET full_name = 'Someone Else' WHERE id = $1", [
      payer.userId,
    ]);
    const after = await asPayer(payer, paymentId);
    expect(after.rawPayload.equals(before.rawPayload)).toBe(true);
    const text = await textOf(after);
    expect(text).toContain('Hōkio Badminton Club');
    expect(text).toContain('Aroha Ngata');
    expect(text).not.toContain('Renamed Club');
  });

  it('lets a team admin fetch the same document from the Payments area (AC-ENTRY-3)', async () => {
    const s = await scene();
    const { paymentId, payer } = await payment(s);
    const mine = await asPayer(payer, paymentId);
    const theirs = await asTeam(s.admin, s.teamId, paymentId);
    expect(theirs.statusCode).toBe(200);
    expect(theirs.headers['content-type']).toBe('application/pdf');
    expect(theirs.headers['cache-control']).toBe('no-store');
    expect(theirs.rawPayload.equals(mine.rawPayload)).toBe(true);
    const log = h.logs
      .lines()
      .filter((line) => line.event === 'invoice.downloaded')
      .at(-1);
    expect(log).toMatchObject({ actorRole: 'team_admin' });
  });
});

// ---------------------------------------------------------------------------------------------
// Not available
// ---------------------------------------------------------------------------------------------

describe('a payment without a document (AC-ERROR-1, AC-ERROR-5)', () => {
  it('answers 409 invoice_not_available for PENDING, OVERDUE, held and $0.00 payments and consumes no number', async () => {
    const s = await scene();
    const pending = await payment(s, { status: 'PENDING' });
    const overdue = await payment(s, { status: 'OVERDUE' });
    const held = await payment(s, { status: 'PENDING' });
    await insertPaymentAttempt(database.pool, {
      paymentId: held.paymentId,
      amount: '23.00',
      status: 'HELD',
      akahuPaymentId: 'fake_held_2300_1_a',
    });
    const free = await payment(s, { amount: '0.00' });
    for (const who of [pending, overdue, held, free]) {
      const res = await asPayer(who.payer, who.paymentId);
      expect(res.statusCode).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'invoice_not_available',
        message: 'An invoice is available once the payment is paid.',
      });
      expect(res.headers['cache-control']).toBe('no-store');
      const admin = await asTeam(s.admin, s.teamId, who.paymentId);
      expect(admin.statusCode).toBe(409);
    }
    expect(await documentCount(s.teamId)).toBe(0);
    expect(await lastNumbers(s.teamId)).toEqual({});
  });

  it('answers 409 invoice_pending, never a 5xx, when the issuing lock stays busy; a later request succeeds (AC-ASYNC-1)', async () => {
    const s = await scene();
    const { paymentId, payer } = await payment(s);
    const service = createInvoiceService({
      db: h.db,
      fonts: await loadInvoiceFonts(),
      lockTimeoutMs: 150,
    });
    const blocker = await database.pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);
      const refusal = await service
        .downloadForPayer(payer.userId, paymentId, h.logs.logger)
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(AppError);
      expect((refusal as AppError).code).toBe('invoice_pending');
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    expect(await documentCount(s.teamId)).toBe(0);
    const ok = await service.downloadForPayer(payer.userId, paymentId, h.logs.logger);
    expect(ok.filename).toBe('tax-invoice-INV-000001.pdf');
  });
});

// ---------------------------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------------------------

describe('nobody can fetch an invoice that is not theirs (AC-ERROR-2, AC-VERIFY-6)', () => {
  it('the payer route: everyone but the payer gets the same 404 as an unknown id; unauthenticated is 401; no number is consumed', async () => {
    const s = await scene();
    const other = await scene({ teamName: 'Other Club' });
    const { paymentId } = await payment(s);
    const otherPlayer = await person(s.teamId, 'MEMBER');
    const teammateAdmin = s.admin;
    const otherTeamAdmin = other.admin;
    const global = await person(null, null);
    await database.pool.query("UPDATE users SET role = 'GLOBAL_ADMIN' WHERE id = $1", [
      global.userId,
    ]);

    const unknown = await asPayer(otherPlayer, '00000000-0000-4000-8000-000000000000');
    expect(unknown.statusCode).toBe(404);
    for (const caller of [otherPlayer, teammateAdmin, otherTeamAdmin, global]) {
      const res = await asPayer(caller, paymentId);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(unknown.json());
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-type']).toContain('application/json');
    }
    const anonymous = await asPayer(null, paymentId);
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers['cache-control']).toBe('no-store');
    expect(await documentCount(s.teamId)).toBe(0);
    expect(await lastNumbers(s.teamId)).toEqual({});
  });

  it('the team route: TEAM_ADMIN of the team only; member, other-team admin, GLOBAL_ADMIN and anonymous are refused before any lookup', async () => {
    const s = await scene();
    const other = await scene({ teamName: 'Other Club' });
    const { paymentId, payer } = await payment(s);
    const member = await person(s.teamId, 'MEMBER');
    const global = await person(null, null);
    await database.pool.query("UPDATE users SET role = 'GLOBAL_ADMIN' WHERE id = $1", [
      global.userId,
    ]);

    for (const refused of [member, other.admin, global, payer]) {
      const res = await asTeam(refused, s.teamId, paymentId);
      expect(res.statusCode).toBe(403);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.rawPayload.subarray(0, 4).toString('latin1')).not.toBe('%PDF');
    }
    expect((await asTeam(null, s.teamId, paymentId)).statusCode).toBe(401);
    // An admin of team B asking team B's route for team A's payment id: resolved with the team, so 404, nothing leaks.
    const crossTeam = await asTeam(other.admin, other.teamId, paymentId);
    expect(crossTeam.statusCode).toBe(404);
    expect(await documentCount(s.teamId)).toBe(0);
    // The real admin still gets it.
    expect((await asTeam(s.admin, s.teamId, paymentId)).statusCode).toBe(200);
  });

  it('rejects a malformed id with 422 and no document', async () => {
    const s = await scene();
    const res = await h.app.inject({
      method: 'GET',
      url: '/payments/not-a-uuid/invoice',
      headers: bearer(s.admin.token),
    });
    expect(res.statusCode).toBe(422);
  });
});

// ---------------------------------------------------------------------------------------------
// The billing read models carry the document reference
// ---------------------------------------------------------------------------------------------

describe('the billing DTOs carry document { kind, available, number } (AC-ENTRY-1, AC-ENTRY-3)', () => {
  it('the payment page, the per-team list and the admin list agree: kind from the snapshot, available while PAID above $0.00, number once issued', async () => {
    const s = await scene();
    const paidUnissued = await payment(s, { payer: await person(s.teamId, 'MEMBER') });
    const more = async (hours: number) =>
      (
        await insertPublishedSession(database.pool, s.teamId, {
          now: new Date(BASE.getTime() - 5 * DAY),
          startsInHours: hours,
          flat: '23.00',
        })
      ).sessionId;
    const withSession = async (hours: number, options: PaymentOptions) =>
      payment(s, { payer: paidUnissued.payer, sessionId: await more(hours), ...options });
    const pending = await withSession(96, { status: 'PENDING' });
    // $0.01 for a registered team has $0.00 GST: the label still says tax invoice (never chosen from gstAmount).
    const penny = await withSession(120, { amount: '0.01' });
    const receipt = await withSession(144, { gst: false });
    const issued = await withSession(168, {});
    await issueDocument(database.pool, issued.paymentId);
    const who = paidUnissued.payer;

    const read = async (id: string) =>
      (
        await h.app.inject({ method: 'GET', url: `/payments/${id}`, headers: bearer(who.token) })
      ).json<PaymentResponse>().payment;
    expect((await read(paidUnissued.paymentId)).document).toEqual({
      kind: 'TAX_INVOICE',
      available: true,
      number: null,
    });
    expect((await read(pending.paymentId)).document).toEqual({
      kind: 'TAX_INVOICE',
      available: false,
      number: null,
    });
    const pennyPayment = await read(penny.paymentId);
    expect(pennyPayment.gstAmount).toBe('0.00');
    expect(pennyPayment.document.kind).toBe('TAX_INVOICE');
    expect((await read(receipt.paymentId)).document.kind).toBe('RECEIPT');
    expect((await read(issued.paymentId)).document).toEqual({
      kind: 'TAX_INVOICE',
      available: true,
      number: 'INV-000001',
    });

    const list = (
      await h.app.inject({
        method: 'GET',
        url: `/teams/${s.teamId}/payments/me`,
        headers: bearer(who.token),
      })
    ).json<MyPaymentsResponse>();
    expect(list.payments.find((row) => row.id === issued.paymentId)?.document).toEqual({
      kind: 'TAX_INVOICE',
      available: true,
      number: 'INV-000001',
    });
    expect(list.payments.find((row) => row.id === pending.paymentId)?.document.available).toBe(
      false,
    );

    const admin = (
      await h.app.inject({
        method: 'GET',
        url: `/teams/${s.teamId}/payments?status=ALL`,
        headers: bearer(s.admin.token),
      })
    ).json<{ payments: { id: string; document: PaymentResponse['payment']['document'] }[] }>();
    expect(admin.payments.find((row) => row.id === receipt.paymentId)?.document).toEqual({
      kind: 'RECEIPT',
      available: true,
      number: null,
    });
    expect(admin.payments.find((row) => row.id === issued.paymentId)?.document.number).toBe(
      'INV-000001',
    );
  });
});

import { describe, expect, it } from 'vitest';
import { parseMoney } from '@sgm/shared';
import { buildBillingPausedEmail, buildLowCreditEmail, buildPaymentDueEmail } from './emails.ts';

const WEB = 'https://games.example.nz';
// 2026-10-07 19:00 in Auckland (UTC+13 in NZDT).
const STARTS_AT = new Date('2026-10-07T06:00:00.000Z');
const DUE = new Date('2026-10-10T06:12:00.000Z');

const base = {
  to: 'sam@example.test',
  firstName: 'Sam',
  teamName: 'Tuesday\nSmashers',
  teamId: 'team-1',
  location: 'Test  Hall',
  startsAt: STARTS_AT,
  webBaseUrl: WEB,
} as const;

describe('payment due email (journey email 1)', () => {
  const due = {
    ...base,
    paymentId: 'pay-1',
    amount: parseMoney('17.00'),
    dueDate: DUE,
    guestCount: 0,
    reason: 'CONFIRMED',
    walletBalance: parseMoney('10.00'),
  } as const;

  it('states the amount, due instant, our payment page link and never an Akahu URL', () => {
    const email = buildPaymentDueEmail(due);
    expect(email.to).toBe('sam@example.test');
    expect(email.subject).toBe('Payment due: Tuesday Smashers, Wed 7 Oct, $17.00, due Sat 10 Oct');
    expect(email.text).toContain('Amount: $17.00');
    expect(email.text).toContain('Due by: Sat 10 Oct, 7:12 pm');
    expect(email.text).toContain(`${WEB}/payments/pay-1`);
    expect(email.text).toContain(`${WEB}/teams/team-1/wallet`);
    expect(email.text).not.toMatch(/https?:\/\/\S*akahu/i); // the copy names Akahu, but no link points at it
    expect(email.idempotencyKey).toBe('payment-due:pay-1');
    expect(email.tags).toEqual({ template: 'payment-due' });
  });

  it('says the wallet did not cover the game when a wallet exists, and that nothing was taken', () => {
    expect(buildPaymentDueEmail(due).text).toContain(
      "Your Tuesday Smashers wallet ($10.00) didn't cover this game, so we haven't taken anything from it.",
    );
  });

  it('says there was no credit when there is no wallet row', () => {
    expect(buildPaymentDueEmail({ ...due, walletBalance: null }).text).toContain(
      "This game wasn't paid from a wallet, because you don't have credit with Tuesday Smashers.",
    );
  });

  it('uses the "Late withdrawal fee" wording for a late withdrawal and names the party size', () => {
    const email = buildPaymentDueEmail({ ...due, reason: 'LATE_WITHDRAWAL', guestCount: 1 });
    expect(email.text).toContain('Late withdrawal fee for Test Hall on Wed 7 Oct.');
    expect(email.text).not.toContain('Thanks for playing');
    expect(email.text).toContain('Amount: $17.00 (you and 1 guest)');
  });

  it('pluralises guests', () => {
    expect(buildPaymentDueEmail({ ...due, guestCount: 2 }).text).toContain('(you and 2 guests)');
  });
});

describe('low credit email (journey email 2)', () => {
  it('names the deduction and the new balance, keyed by the deduction', () => {
    const email = buildLowCreditEmail({
      ...base,
      deducted: parseMoney('17.00'),
      balance: parseMoney('18.00'),
      creditTransactionId: 'tx-9',
    });
    expect(email.subject).toBe('Your Tuesday Smashers wallet is running low ($18.00)');
    expect(email.text).toContain(
      'We took $17.00 from your Tuesday Smashers wallet for Test Hall on Wed 7 Oct. Your balance is now $18.00.',
    );
    expect(email.text).toContain(`${WEB}/teams/team-1/wallet`);
    expect(email.idempotencyKey).toBe('low-credit:tx-9');
    expect(email.tags).toEqual({ template: 'low-credit' });
  });
});

describe('billing paused email (journey email 11, B8)', () => {
  it('goes to one admin, links the banking page and carries no account detail', () => {
    const email = buildBillingPausedEmail({
      to: 'admin@example.test',
      adminFirstName: 'Alex',
      adminId: 'admin-1',
      teamName: 'Tuesday Smashers',
      teamId: 'team-1',
      sessionId: 'sess-1',
      location: 'Test Hall',
      startsAt: STARTS_AT,
      webBaseUrl: WEB,
    });
    expect(email.to).toBe('admin@example.test');
    expect(email.subject).toBe('Billing is paused: Tuesday Smashers, Wed 7 Oct');
    expect(email.text).toContain('Nobody has been charged for it yet.');
    expect(email.text).toContain(`${WEB}/teams/team-1/manage/banking`);
    expect(email.idempotencyKey).toBe('billing-paused:sess-1:admin-1');
    expect(email.tags).toEqual({ template: 'billing-paused' });
  });
});

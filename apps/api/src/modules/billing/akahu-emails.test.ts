/**
 * The emails the apply funnel sends (journey emails 5-10; CR-20 numbering 5 payment received, 6 top-up received, 7 not completed,
 * 8 held, 9 money received but not applied). Copy is the user-journey doc's; every link is our own origin; keys come from the cause.
 */
import { describe, expect, it } from 'vitest';
import { parseMoney } from '@sgm/shared';
import {
  buildExtraPaymentAdminEmail,
  buildExtraPaymentPlayerEmail,
  buildPaymentHeldEmail,
  buildPaymentNotCompletedEmail,
  buildPaymentReceivedEmail,
  buildPayoutBlockedEmail,
  buildTopUpHeldEmail,
  buildTopUpNotCompletedEmail,
  buildTopUpReceivedEmail,
} from './emails.ts';

const WEB = 'https://games.example.nz';
// 2026-10-07 19:00 in Auckland (NZDT, UTC+13).
const STARTS_AT = new Date('2026-10-07T06:00:00.000Z');
const PAID_AT = new Date('2026-10-10T05:03:00.000Z');
const DUE = new Date('2026-10-10T06:12:00.000Z');
const AMOUNT = parseMoney('17.00');

const session = {
  to: 'sam@example.test',
  firstName: 'Sam',
  teamName: 'Tuesday\nSmashers',
  teamId: 'team-1',
  location: 'Test  Hall',
  startsAt: STARTS_AT,
  webBaseUrl: WEB,
} as const;
const wallet = {
  to: 'sam@example.test',
  firstName: 'Sam',
  teamName: 'Tuesday Smashers',
  teamId: 'team-1',
  webBaseUrl: WEB,
} as const;

const noAkahuLink = (text: string): void => {
  expect(text).not.toMatch(/https?:\/\/\S*akahu/i);
};

describe('payment received (email 5)', () => {
  it('names the amount, session and paid instant, links our payment page, keyed by the payment', () => {
    const email = buildPaymentReceivedEmail({
      ...session,
      paymentId: 'pay-1',
      amount: AMOUNT,
      paidAt: PAID_AT,
      afterHold: false,
    });
    expect(email.subject).toBe('Payment received: Tuesday Smashers, $17.00');
    expect(email.text).toContain(
      'We received your payment of $17.00 for Test Hall on Wed 7 Oct. It was paid to Tuesday Smashers by bank transfer on Sat 10 Oct, 6:03 pm.',
    );
    expect(email.text).toContain(`${WEB}/payments/pay-1`);
    expect(email.text).not.toContain('We checked with your bank');
    noAkahuLink(email.text);
    expect(email.idempotencyKey).toBe('payment-received:pay-1');
    expect(email.tags).toEqual({ template: 'payment-received' });
  });

  it('adds the hold line after a hold was resolved by the bank', () => {
    const email = buildPaymentReceivedEmail({
      ...session,
      paymentId: 'pay-1',
      amount: AMOUNT,
      paidAt: PAID_AT,
      afterHold: true,
    });
    expect(email.text).toContain('We checked with your bank and your payment went through.');
  });
});

describe('top-up received (email 6)', () => {
  it('names the amount and the new balance, links the wallet, keyed by the top-up', () => {
    const email = buildTopUpReceivedEmail({
      ...wallet,
      topUpId: 'tu-1',
      amount: parseMoney('30.00'),
      balance: parseMoney('45.00'),
    });
    expect(email.subject).toBe('Top-up received: Tuesday Smashers wallet, $30.00');
    expect(email.text).toContain(
      'Your top-up of $30.00 to your Tuesday Smashers wallet went through. Your balance is now $45.00.',
    );
    expect(email.text).toContain(`${WEB}/teams/team-1/wallet`);
    noAkahuLink(email.text);
    expect(email.idempotencyKey).toBe('top-up-received:tu-1');
  });
});

describe('payment not completed (email 7)', () => {
  it('says nothing was charged, states the (grace) due date and links the payment page, keyed by the attempt', () => {
    const email = buildPaymentNotCompletedEmail({
      ...session,
      attemptId: 'att-1',
      paymentId: 'pay-1',
      amount: AMOUNT,
      dueDate: DUE,
      overdue: false,
      afterHold: false,
    });
    expect(email.subject).toBe("Your payment to Tuesday Smashers didn't go through");
    expect(email.text).toContain(
      "Your bank didn't complete your payment of $17.00 for Test Hall on Wed 7 Oct. You haven't been charged.",
    );
    expect(email.text).toContain('The payment is still due by Sat 10 Oct, 7:12 pm.');
    expect(email.text).toContain(`${WEB}/payments/pay-1`);
    expect(email.idempotencyKey).toBe('payment-not-completed:att-1');
  });

  it('says it is overdue instead of restating a due date for an OVERDUE payment, and adds the hold line', () => {
    const email = buildPaymentNotCompletedEmail({
      ...session,
      attemptId: 'att-1',
      paymentId: 'pay-1',
      amount: AMOUNT,
      dueDate: DUE,
      overdue: true,
      afterHold: true,
    });
    expect(email.text).toContain('It was due by Sat 10 Oct, 7:12 pm and is now overdue.');
    expect(email.text).toContain("We checked with your bank: the payment didn't go through.");
  });

  it('has a top-up variant that links the wallet', () => {
    const email = buildTopUpNotCompletedEmail({
      ...wallet,
      topUpId: 'tu-1',
      amount: parseMoney('30.00'),
      afterHold: false,
    });
    expect(email.subject).toBe("Your top-up to your Tuesday Smashers wallet didn't go through");
    expect(email.text).toContain("You haven't been charged.");
    expect(email.text).toContain(`${WEB}/teams/team-1/wallet`);
    expect(email.idempotencyKey).toBe('top-up-not-completed:tu-1');
  });
});

describe('held notice (email 8)', () => {
  it('asks the player not to pay again, never says "you haven\'t been charged", keyed by the attempt', () => {
    const email = buildPaymentHeldEmail({
      ...session,
      attemptId: 'att-1',
      paymentId: 'pay-1',
      amount: AMOUNT,
      overdue: false,
    });
    expect(email.subject).toBe("We're checking your payment to Tuesday Smashers");
    expect(email.text).toContain(
      "Your bank couldn't confirm whether your payment of $17.00 for Test Hall on Wed 7 Oct went through.",
    );
    expect(email.text).toContain("Please don't pay it again.");
    expect(email.text).toContain("This payment won't become overdue while we check.");
    expect(email.text).not.toMatch(/haven't been charged/);
    expect(email.idempotencyKey).toBe('payment-held:att-1');
  });

  it('drops the overdue promise for a payment that is already overdue', () => {
    const email = buildPaymentHeldEmail({
      ...session,
      attemptId: 'att-1',
      paymentId: 'pay-1',
      amount: AMOUNT,
      overdue: true,
    });
    expect(email.text).not.toContain("won't become overdue");
  });

  it('has a top-up variant', () => {
    const email = buildTopUpHeldEmail({ ...wallet, topUpId: 'tu-1', amount: parseMoney('30.00') });
    expect(email.subject).toBe("We're checking your top-up to your Tuesday Smashers wallet");
    expect(email.text).toContain("You can't start another top-up until this is sorted.");
    expect(email.text).not.toMatch(/haven't been charged/);
    expect(email.idempotencyKey).toBe('top-up-held:tu-1');
  });
});

describe('money received but not applied (email 9, B3)', () => {
  it('tells the player the money is with the team and the admins were asked to refund', () => {
    const email = buildExtraPaymentPlayerEmail({
      ...wallet,
      intentId: 'att-2',
      amount: AMOUNT,
      reason: 'DUPLICATE',
      location: 'Test Hall',
      startsAt: STARTS_AT,
    });
    expect(email.subject).toBe('We received an extra payment from you');
    expect(email.text).toContain(
      "We received $17.00 more than you owed for Test Hall on Wed 7 Oct. The money is in Tuesday Smashers's bank account, and we've asked the team admins to refund you.",
    );
    expect(email.idempotencyKey).toBe('extra-payment:att-2:player');
  });

  it('tells each admin who paid what and why, links the Payments area, keyed per admin', () => {
    const email = buildExtraPaymentAdminEmail({
      to: 'ana@example.test',
      adminFirstName: 'Ana',
      adminId: 'admin-1',
      playerFullName: 'Sam\nPlayer',
      teamName: 'Tuesday Smashers',
      teamId: 'team-1',
      webBaseUrl: WEB,
      intentId: 'tu-9',
      amount: parseMoney('30.00'),
      reason: 'OVER_CAP',
      location: null,
      startsAt: null,
    });
    expect(email.subject).toBe('A payment to Tuesday Smashers needs a refund');
    expect(email.text).toContain(
      "Sam Player paid $30.00 that we couldn't use: a top-up over the $100.00 wallet limit.",
    );
    expect(email.text).toContain("We haven't added it to their wallet.");
    expect(email.text).toContain(`${WEB}/teams/team-1/manage/payments`);
    expect(email.idempotencyKey).toBe('extra-payment:tu-9:admin-1');
  });

  it('names a duplicate by the game day, and a late top-up and an amount mismatch by their cause', () => {
    const admin = {
      to: 'ana@example.test',
      adminFirstName: 'Ana',
      adminId: 'admin-1',
      playerFullName: 'Sam Player',
      teamName: 'Tuesday Smashers',
      teamId: 'team-1',
      webBaseUrl: WEB,
      intentId: 'x',
      amount: AMOUNT,
    } as const;
    expect(
      buildExtraPaymentAdminEmail({
        ...admin,
        reason: 'DUPLICATE',
        location: 'Test Hall',
        startsAt: STARTS_AT,
      }).text,
    ).toContain('paid twice for Wed 7 Oct');
    expect(
      buildExtraPaymentAdminEmail({ ...admin, reason: 'LATE', location: null, startsAt: null })
        .text,
    ).toContain(
      'a top-up that arrived after it was closed and no longer fit under the $100.00 wallet limit',
    );
    expect(
      buildExtraPaymentAdminEmail({
        ...admin,
        reason: 'AMOUNT_MISMATCH',
        location: null,
        startsAt: null,
      }).text,
    ).toContain('a payment for a different amount than we asked for');
  });
});

describe('payout blocked (CR-20 email 10, admins; A3)', () => {
  const blockedAt = new Date('2026-10-08T07:20:00.000Z');

  it('tells the admin what stops and how to lift it, links the banking page, and names no account detail', () => {
    const email = buildPayoutBlockedEmail({
      to: 'ana@example.test',
      adminFirstName: 'Ana',
      adminId: 'admin-1',
      teamName: 'Tuesday\nSmashers',
      teamId: 'team-1',
      payoutBlockedAt: blockedAt,
      webBaseUrl: WEB,
    });
    expect(email.subject).toBe("Payments to Tuesday Smashers's bank account are failing");
    expect(email.text).toContain('Hi Ana,');
    expect(email.text).toContain(
      "Payments to Tuesday Smashers's bank account aren't going through.",
    );
    expect(email.text).toContain("- new paid sessions can't be published,");
    expect(email.text).toContain(`${WEB}/teams/team-1/manage/banking`);
    expect(email.text).toContain('Saving the bank details lifts the block.');
    // No account name or digits: the input carries none, and nothing that looks like an account number appears.
    expect(email.text).not.toMatch(/\d{2}-\d{4}-\d{7}/);
    noAkahuLink(email.text);
    // One email per admin per block episode (the block instant), so a second ops action while blocked sends nothing new.
    expect(email.idempotencyKey).toBe(`payout-blocked:team-1:${blockedAt.getTime()}:admin-1`);
    expect(email.tags).toEqual({ template: 'payout-blocked' });
  });
});

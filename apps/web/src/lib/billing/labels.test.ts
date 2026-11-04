import { describe, expect, it } from 'vitest';
import {
  AKAHU_LEAVE_LINE,
  HOLD_BODY,
  HOLD_HEADING,
  basisLabel,
  billingErrorLines,
  cooldownText,
  declinedText,
  dueLine,
  formatDay,
  holdResolutionResultMessage,
  ledgerDescription,
  paymentTag,
  payButtonLabel,
  payoutBlockResultMessage,
  reminderCell,
  reminderPrompt,
  signedAmountText,
  topUpHint,
  topUpTrustLines,
} from './labels.ts';

// 2026-10-07 07:00 UTC is Wed 7 Oct, 8:00 pm in Pacific/Auckland (NZDT, UTC+13).
const SESSION = '2026-10-07T07:00:00.000Z';
// 2026-10-09 22:00 UTC is Sat 10 Oct 11:00 am NZDT.
const DUE = '2026-10-09T22:00:00.000Z';

describe('dates are shown in Pacific/Auckland, short NZ style', () => {
  it('formats an instant as "Wed 7 Oct" and moves across the date line', () => {
    expect(formatDay(SESSION)).toBe('Wed 7 Oct');
    // 23:30 UTC on the 9th is already Sat 10 Oct in NZ.
    expect(formatDay('2026-10-09T23:30:00.000Z')).toBe('Sat 10 Oct');
  });

  it('dueLine says "Due" before and "Overdue since" after, with the stored due date', () => {
    expect(dueLine('PENDING', DUE)).toBe('Due Sat 10 Oct');
    expect(dueLine('OVERDUE', DUE)).toBe('Overdue since Sat 10 Oct');
  });
});

describe('paymentTag: text, never colour alone (UI/UX "Status tags", CR-18)', () => {
  const base = {
    status: 'PENDING' as const,
    billingType: 'PER_GAME' as const,
    amount: '17.00',
    dueDate: DUE,
    onHold: false,
  };

  it.each([
    ['pending', {}, 'Due Sat 10 Oct', 'amber'],
    ['overdue', { status: 'OVERDUE' as const }, 'Overdue since Sat 10 Oct', 'red'],
    ['paid per game', { status: 'PAID' as const }, 'Paid', 'green'],
    [
      'paid from wallet',
      { status: 'PAID' as const, billingType: 'PREPAID_CREDIT' as const },
      'Paid from wallet',
      'green',
    ],
    [
      'paid with nothing to pay (B7)',
      { status: 'PAID' as const, amount: '0.00' },
      'No charge',
      'slate',
    ],
    ['held pending', { onHold: true }, 'Under review', 'slate'],
    ['held overdue', { status: 'OVERDUE' as const, onHold: true }, 'Under review', 'slate'],
  ])('%s', (_name, change, text, tone) => {
    expect(paymentTag({ ...base, ...change })).toEqual({ text, tone });
  });
});

describe('policy and trust copy (ruling H3: final wording)', () => {
  it('states where the money goes and what wallet credit is for, with the team name', () => {
    const lines = topUpTrustLines('Rosedale');
    expect(lines).toEqual([
      AKAHU_LEAVE_LINE,
      "The money goes to Rosedale's bank account.",
      "Wallet credit can only be used for Rosedale's game fees.",
    ]);
    expect(AKAHU_LEAVE_LINE).toBe(
      "You'll leave this site to approve the payment with your bank through Akahu.",
    );
  });

  it('formats the amount hint from money values only', () => {
    expect(topUpHint('87.50')).toBe('Between $1.00 and $87.50.');
  });

  it('the hold copy never says the payer was not charged (CR-18)', () => {
    expect(HOLD_HEADING).toBe("We're checking this payment with your bank.");
    expect(HOLD_BODY).toBe(
      "We can't tell yet whether it went through. Please don't pay again. We'll email you as soon as we know.",
    );
    expect(`${HOLD_HEADING} ${HOLD_BODY}`).not.toContain("haven't been charged");
    expect(declinedText('payment')).toBe(
      "Your payment didn't go through. You haven't been charged.",
    );
    expect(declinedText('top-up')).toBe("Your top-up didn't go through. You haven't been charged.");
  });
});

describe('pay button labels', () => {
  it('names the amount for a first payment and says "Try again" / "Continue with Akahu" otherwise', () => {
    expect(payButtonLabel('pay', '17.00')).toBe('Pay $17.00 with Akahu');
    expect(payButtonLabel('retry', '17.00')).toBe('Try again');
    expect(payButtonLabel('continue', '17.00')).toBe('Continue with Akahu');
  });
});

describe('line items and ledger rows', () => {
  it.each([
    ['FLAT', 'Flat fee'],
    ['SEX_MALE', "Men's rate"],
    ['SEX_FEMALE', "Women's rate"],
    ['SEX_OTHER', 'Other rate'],
    ['SKILL_BEGINNER', 'Beginner level'],
    ['SKILL_INTERMEDIATE', 'Intermediate level'],
    ['SKILL_ADVANCED', 'Advanced level'],
  ] as const)('%s reads "%s"', (basis, label) => {
    expect(basisLabel(basis)).toBe(label);
  });

  it('signs ledger amounts with a real plus or minus sign', () => {
    expect(signedAmountText('30.00')).toBe('+$30.00');
    expect(signedAmountText('-17.00')).toBe('−$17.00');
    expect(signedAmountText('0.00')).toBe('$0.00');
  });

  it('describes each ledger type; a game fee names the session', () => {
    const session = { id: 'x', location: 'Rosedale Hall', startsAt: SESSION };
    expect(ledgerDescription({ type: 'TOPUP', session: null })).toBe('Top-up');
    expect(ledgerDescription({ type: 'REFUND', session: null })).toBe('Refund');
    expect(ledgerDescription({ type: 'AUTO_DEDUCTION', session })).toBe(
      'Game fee, Rosedale Hall, Wed 7 Oct',
    );
    expect(ledgerDescription({ type: 'AUTO_DEDUCTION', session: null })).toBe('Game fee');
  });
});

describe('admin reminder copy and cooldown text', () => {
  const NOW = new Date('2026-10-29T03:30:00.000Z'); // Thu 29 Oct, 4:30 pm NZDT
  const SENT_TODAY = '2026-10-29T01:14:00.000Z'; // Thu 29 Oct, 2:14 pm NZDT
  const SENT_EARLIER = '2026-10-27T01:14:00.000Z'; // Tue 27 Oct, 2:14 pm NZDT

  it('prompts with the first name and the amount only', () => {
    expect(reminderPrompt('Priya', '17.00')).toBe('Email Priya a reminder for $17.00?');
  });

  it('last-reminder cell: "No reminder yet", a time for today, a date and time otherwise', () => {
    expect(reminderCell(null, NOW)).toBe('No reminder yet');
    expect(reminderCell(SENT_TODAY, NOW)).toBe('Reminder sent 2:14 pm');
    expect(reminderCell(SENT_EARLIER, NOW)).toBe('Reminder sent Tue 27 Oct, 2:14 pm');
  });

  it('cooldown text names when the last one went and when another may be sent', () => {
    expect(cooldownText(SENT_TODAY, NOW)).toBe(
      'Reminder sent 2:14 pm. You can send another after Fri 30 Oct, 2:14 pm.',
    );
  });
});

describe('result messages of the hold-resolution and payout-block actions', () => {
  it.each([
    ['APPLIED', 'Recorded. The payment is now marked as paid.'],
    [
      'UNAPPLIED',
      'Recorded, not applied. The amount that arrived did not match what was due, so the payment stays unpaid and the player has been told.',
    ],
    ['CLOSED', 'Recorded. The payment can be paid again.'],
    ['OPEN', 'Recorded.'],
  ] as const)('hold resolution %s', (status, message) => {
    expect(holdResolutionResultMessage(status)).toBe(message);
  });

  it('payout block: says whether it was already blocked', () => {
    expect(payoutBlockResultMessage(false)).toBe(
      'Payments to this team are now blocked. The team admins have been told.',
    );
    expect(payoutBlockResultMessage(true)).toBe('Payments to this team were already blocked.');
  });
});

describe('billingErrorLines: the copy of every action error code', () => {
  it.each([
    [
      'top_up_in_progress',
      ['You already have a top-up in progress. It will show here once your bank confirms it.'],
    ],
    [
      'payment_in_progress',
      ["You've already started this payment. It can take a minute to show here."],
    ],
    ['payment_settled', ['That payment has already been paid.']],
    [
      'payment_on_hold',
      [
        "We're checking this payment with your bank.",
        "Please don't pay again. We'll email you as soon as we know.",
      ],
    ],
    [
      'payout_not_configured',
      ["This team can't receive payments right now. We've told the team admins."],
    ],
    [
      'payment_provider_unavailable',
      ["We couldn't reach Akahu. Nothing has been charged. Try again in a few minutes."],
    ],
    [
      'service_unavailable',
      ['Something went wrong on our side. Nothing has been charged. Try again in a few minutes.'],
    ],
    [
      'offline',
      ['Something went wrong on our side. Nothing has been charged. Try again in a few minutes.'],
    ],
    ['forbidden', ['You need to be a member of this team to use its wallet.']],
    ['not_found', ["We couldn't find that payment."]],
    ['key_invalid', ['Reload the page and try again.']],
    [
      'refused_amount_over_bank_limit',
      ["Your bank won't allow a payment this large through Akahu. Nothing has been charged."],
    ],
    [
      'refused_payer_bank_unavailable',
      [
        "Your bank isn't available through Akahu right now. Nothing has been charged. Try again later.",
      ],
    ],
    [
      'refused_payee_unusable',
      ["This team can't receive payments right now. We've told the team admins."],
    ],
    [
      'something_unknown',
      ['Something went wrong on our side. Nothing has been charged. Try again in a few minutes.'],
    ],
  ])('%s', (code, lines) => {
    expect(billingErrorLines(code)).toEqual(lines);
  });

  it('admin scope: forbidden and the reminder refusals read for an admin', () => {
    expect(billingErrorLines('forbidden', { scope: 'admin' })).toEqual([
      "You don't have access to manage this team.",
    ]);
    expect(billingErrorLines('reminder_too_soon', { scope: 'admin' })).toEqual([
      'A reminder was already sent recently. The row now shows when you can send another.',
    ]);
    expect(billingErrorLines('hold_resolved_by_provider', { scope: 'admin' })).toEqual([
      "The bank has since confirmed what happened, so your choice wasn't applied. The page now shows the result.",
    ]);
  });

  it('no error copy ever contains a payment link, token or bank detail marker', () => {
    for (const code of ['payment_in_progress', 'payment_on_hold', 'payout_not_configured']) {
      const text = billingErrorLines(code).join(' ');
      expect(text).not.toMatch(/https?:|token|account number/i);
    }
  });
});

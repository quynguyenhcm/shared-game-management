import { describe, expect, it } from 'vitest';
import type { ApiResult } from '../api-client.ts';
import { toAdminResult, toStartOutcome } from './outcome.ts';

type Failure = Extract<ApiResult<unknown>, { ok: false }>;

function fail(
  status: number,
  code: string,
  extras: Partial<Omit<Failure, 'ok' | 'status' | 'error'>> & {
    fieldErrors?: Record<string, string[]>;
  } = {},
): Failure {
  const { fieldErrors, ...rest } = extras;
  return {
    ok: false,
    status,
    error: {
      code,
      message: 'x',
      ...(fieldErrors === undefined ? {} : { fieldErrors }),
    } as Failure['error'],
    ...rest,
  };
}

const VALUES = { amount: '20.00' };
const ok = (redirectUrl: string): ApiResult<{ redirectUrl: string }> => ({
  ok: true,
  status: 201,
  data: { redirectUrl },
});

describe('toStartOutcome: success', () => {
  it('redirects to the Akahu URL the API returned', () => {
    expect(toStartOutcome(ok('https://api.akahu.example/consent/1'), VALUES)).toEqual({
      kind: 'redirect',
      url: 'https://api.akahu.example/consent/1',
    });
  });

  it('refuses a URL that is not http(s): a bad redirect never reaches the browser', () => {
    const outcome = toStartOutcome(ok('javascript:alert(1)'), VALUES);
    expect(outcome).toEqual({
      kind: 'state',
      state: { error: { code: 'service_unavailable' }, values: VALUES },
      revalidate: false,
    });
  });
});

describe('toStartOutcome: failure mapping table (AC-ERROR-1, 3, 4, 7, CR-6)', () => {
  it.each([
    [
      '503 provider unavailable',
      fail(503, 'payment_provider_unavailable'),
      'payment_provider_unavailable',
      false,
    ],
    [
      '503 with no parseable body',
      fail(503, 'service_unavailable'),
      'payment_provider_unavailable',
      false,
    ],
    ['500', fail(500, 'internal_error'), 'service_unavailable', false],
    ['network failure', fail(0, 'service_unavailable'), 'service_unavailable', false],
    ['payout not configured', fail(409, 'payout_not_configured'), 'payout_not_configured', true],
    ['already paid in another tab', fail(409, 'payment_settled'), 'payment_settled', true],
    ['held', fail(409, 'payment_on_hold'), 'payment_on_hold', true],
    ['403', fail(403, 'forbidden'), 'forbidden', false],
    ['404', fail(404, 'not_found'), 'not_found', false],
    [
      'in progress without a link left',
      fail(409, 'payment_in_progress', { resume: { redirectUrl: null, topUp: null } }),
      'payment_in_progress',
      true,
    ],
    [
      'top-up in progress without a link left',
      fail(409, 'top_up_in_progress', { resume: { redirectUrl: null, topUp: null } }),
      'top_up_in_progress',
      true,
    ],
    [
      'top-up in progress with no resume at all',
      fail(409, 'top_up_in_progress'),
      'top_up_in_progress',
      true,
    ],
    [
      'refused: payee unusable',
      fail(422, 'payment_provider_refused', { refusalReason: 'payee_unusable' }),
      'refused_payee_unusable',
      false,
    ],
    [
      'refused: over the bank limit',
      fail(422, 'payment_provider_refused', { refusalReason: 'amount_over_bank_limit' }),
      'refused_amount_over_bank_limit',
      false,
    ],
    [
      'refused: payer bank unavailable',
      fail(422, 'payment_provider_refused', { refusalReason: 'payer_bank_unavailable' }),
      'refused_payer_bank_unavailable',
      false,
    ],
    [
      'refused without a reason',
      fail(422, 'payment_provider_refused'),
      'payment_provider_refused',
      false,
    ],
    ['429', fail(429, 'too_many_requests', { retryAfterSeconds: 90 }), 'too_many_requests', false],
  ])('%s', (_name, failure, code, revalidate) => {
    const outcome = toStartOutcome(failure, VALUES);
    expect(outcome.kind).toBe('state');
    if (outcome.kind !== 'state') return;
    expect(outcome.state.error?.code).toBe(code);
    expect(outcome.state.values).toEqual(VALUES);
    expect(outcome.revalidate).toBe(revalidate);
  });

  it('a 429 keeps the retry-after so the banner can say how long', () => {
    const outcome = toStartOutcome(
      fail(429, 'too_many_requests', { retryAfterSeconds: 90 }),
      VALUES,
    );
    expect(outcome.kind === 'state' && outcome.state.error?.retryAfterSeconds).toBe(90);
  });

  it('422 field errors go beside the field, with what was typed kept', () => {
    const outcome = toStartOutcome(
      fail(422, 'validation_failed', {
        fieldErrors: { amount: ['You can top up at most $15.00.'] },
      }),
      VALUES,
    );
    expect(outcome).toEqual({
      kind: 'state',
      state: { fieldErrors: { amount: ['You can top up at most $15.00.'] }, values: VALUES },
      revalidate: false,
    });
  });

  it('409 with a resume link (payment in progress or top-up in progress) follows it: not an error to the player', () => {
    for (const code of ['payment_in_progress', 'top_up_in_progress']) {
      expect(
        toStartOutcome(
          fail(409, code, {
            resume: { redirectUrl: 'https://api.akahu.example/consent/9', topUp: null },
          }),
          VALUES,
        ),
      ).toEqual({ kind: 'redirect', url: 'https://api.akahu.example/consent/9' });
    }
  });

  it('a resume link that is not http(s) is not followed', () => {
    const outcome = toStartOutcome(
      fail(409, 'payment_in_progress', {
        resume: { redirectUrl: 'data:text/html,x', topUp: null },
      }),
      VALUES,
    );
    expect(outcome.kind).toBe('state');
  });
});

describe('toAdminResult: reminder, hold resolution and payout block (AC-ERROR, CR-14, CR-15, CR-26)', () => {
  const ctx = { action: 'reminder' as const, success: 'Reminder sent to Priya for $17.00.' };

  it('success carries the supplied message and asks for a refresh', () => {
    expect(toAdminResult({ ok: true, status: 202, data: {} }, ctx)).toEqual({
      ok: true,
      message: 'Reminder sent to Priya for $17.00.',
      refresh: true,
    });
  });

  it.each([
    ['payment_settled', 409, 'That payment has already been paid.', true],
    [
      'reminder_too_soon',
      409,
      'A reminder was already sent recently. The row now shows when you can send another.',
      true,
    ],
    ['payment_on_hold', 409, 'This payment is under review, so no reminder can be sent.', true],
    [
      'payout_not_configured',
      409,
      "This team can't receive payments right now. We've told the team admins.",
      true,
    ],
    ['forbidden', 403, "You don't have access to manage this team.", true],
    ['not_found', 404, "We couldn't find that payment.", true],
  ])('reminder %s', (code, status, message, refresh) => {
    expect(toAdminResult(fail(status, code), ctx)).toMatchObject({
      ok: false,
      code,
      message,
      refresh,
    });
  });

  it('hold resolution: the provider has already decided (CR-26), a stale conflict, and an observed-amount 422', () => {
    const hold = { action: 'hold' as const, success: 'unused' };
    expect(toAdminResult(fail(409, 'hold_resolved_by_provider'), hold)).toMatchObject({
      ok: false,
      code: 'hold_resolved_by_provider',
      message:
        "The bank has since confirmed what happened, so your choice wasn't applied. The page now shows the result.",
      refresh: true,
      close: true,
    });
    expect(toAdminResult(fail(409, 'conflict'), hold)).toMatchObject({
      ok: false,
      code: 'conflict',
      message: 'This payment changed while you were looking at it. The page has been refreshed.',
      refresh: true,
    });
    const invalid = toAdminResult(
      fail(422, 'validation_failed', {
        fieldErrors: { observedAmount: ['Enter at least $1.00.'] },
      }),
      hold,
    );
    expect(invalid).toMatchObject({
      ok: false,
      code: 'validation_failed',
      message: 'Enter at least $1.00.',
      refresh: false,
      fieldErrors: { observedAmount: ['Enter at least $1.00.'] },
    });
  });

  it('503 and an unreachable API never claim success or refresh, and keep the confirm open', () => {
    for (const failure of [
      fail(503, 'payment_provider_unavailable'),
      fail(0, 'service_unavailable'),
    ]) {
      const result = toAdminResult(failure, ctx);
      expect(result.ok).toBe(false);
      expect(result.refresh).toBe(false);
      expect(result.close).toBeUndefined();
      expect(result.message).toContain('Something went wrong on our side');
    }
  });
});

/**
 * The provider half of every payment start (wallet-and-akahu-billing Phase 4a; A5, B10, CR-6, CR-7; algorithm doc D). Both start
 * paths (a wallet top-up and a payment attempt) commit their intent row first (tx1), then call `startProviderPayment` OUTSIDE any
 * transaction, then record the answer in their own tx2. This file writes nothing and logs nothing:
 *
 *   - the team's payee name and account number are decrypted here, in memory, only for the one create call, normalised to the
 *     provider's charset, and go out of scope when the call returns (B10: "decrypt late, forget early"); a payee that cannot be
 *     opened or normalised is a local `payee_unusable` refusal and no call is made;
 *   - the create is made once and never retried blindly: a timeout, 5xx, network error or a thrown error is `unavailable`
 *     (ambiguous; the caller closes its intent and the reconcile/orphan-cancel path is the safety net);
 *   - a definite refusal is mapped to a stable, provider-neutral reason.
 *
 * The consent URL is stored only as a FieldCrypto envelope bound to its own row (`sealAuthorisationUrl`), and handed out again
 * only while the payer is still awaited and the link has `RESUME_MIN_REMAINING_MS` left (`resumeUrl`).
 */
import { randomBytes } from 'node:crypto';
import type { Money, PaymentIntentStatus, ProviderRefusalReason } from '@sgm/shared';
import { DecryptionError, type FieldCrypto } from '../crypto/crypto.ts';
import type { PaymentsConfig } from './config.ts';
import { RESUME_MIN_REMAINING_MS } from './constants.ts';
import type { CreateRefusalCode, PaymentsGateway } from './gateway.ts';
import { normalisePayeeName } from './payee.ts';

export interface PaymentStartSettings {
  /** `AKAHU_PAYMENT_EXPIRY_MINUTES`: how long the consent link lives. */
  readonly expiryMinutes: number;
  /** `AKAHU_WEBHOOK_URL` with the live adapter; an inert URL with the fake (it never calls back). */
  readonly webhookUrl: string;
}

/** Where the fake adapter is told to send webhooks: it never does (dev, CI and E2E run without a webhook). */
const FAKE_WEBHOOK_URL = 'https://payments-fake.invalid/webhooks/akahu';

export function paymentStartSettings(payments: PaymentsConfig): PaymentStartSettings {
  return {
    expiryMinutes: payments.paymentExpiryMinutes,
    webhookUrl: payments.akahu?.webhookUrl ?? FAKE_WEBHOOK_URL,
  };
}

/** The team's payout columns as stored: envelopes sealed under `teams.bank_account_*:<teamId>`. */
export interface SealedPayee {
  readonly teamId: string;
  readonly nameEnvelope: string | null;
  readonly numberEnvelope: string | null;
}

export type ProviderStart =
  | {
      readonly kind: 'created';
      readonly providerPaymentId: string;
      readonly providerStatus: string;
      readonly providerStatusReason: string | null;
      readonly authorisationUrl: string;
      readonly expiresAt: Date;
    }
  | {
      readonly kind: 'refused';
      readonly reason: ProviderRefusalReason;
      readonly code: CreateRefusalCode;
    }
  | { readonly kind: 'unavailable' };

const REFUSAL_REASON: Readonly<Record<CreateRefusalCode, ProviderRefusalReason>> = {
  invalid_payee: 'payee_unusable',
  payee_unusable: 'payee_unusable',
  single_limit_exceeded: 'amount_over_bank_limit',
  bank_limit_exceeded: 'amount_over_bank_limit',
  invalid_payer: 'payer_bank_unavailable',
  other: 'payer_bank_unavailable',
};

/** `close_reason` of an intent the provider could not start: replayed by key, the same answer is given again. */
export type CreateFailure =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'refused'; readonly reason: ProviderRefusalReason };

export const createFailureCloseReason = (
  start: Exclude<ProviderStart, { kind: 'created' }>,
): string => (start.kind === 'unavailable' ? 'create_unavailable' : `create_refused:${start.code}`);

/** Reads a create-time close reason back (null for any other close: those replay as the intent they became). */
export function createFailureOf(closeReason: string | null): CreateFailure | null {
  if (closeReason === 'create_unavailable') return { kind: 'unavailable' };
  if (closeReason?.startsWith('create_refused:') === true) {
    const code = closeReason.slice('create_refused:'.length);
    return {
      kind: 'refused',
      reason: Object.hasOwn(REFUSAL_REASON, code)
        ? REFUSAL_REASON[code as CreateRefusalCode]
        : 'payer_bank_unavailable',
    };
  }
  return null;
}

const UNUSABLE: ProviderStart = {
  kind: 'refused',
  reason: 'payee_unusable',
  code: 'payee_unusable',
};

/** Opens one payout envelope; null when it is missing or cannot be opened for this team (never thrown, never logged here). */
function openPayee(
  crypto: FieldCrypto,
  envelope: string | null,
  teamId: string,
  column: 'bank_account_name' | 'bank_account_number',
): string | null {
  if (envelope === null) return null;
  try {
    return crypto.decrypt(envelope, { table: 'teams', column, rowId: teamId });
  } catch (error) {
    if (error instanceof DecryptionError) return null;
    throw error;
  }
}

export async function startProviderPayment(
  deps: {
    readonly gateway: Pick<PaymentsGateway, 'createPayment'>;
    readonly crypto: FieldCrypto;
    readonly settings: PaymentStartSettings;
  },
  input: {
    readonly amount: Money;
    readonly reference: string;
    readonly redirectUri: string;
    readonly payee: SealedPayee;
    /** The start's clock reading: the link expires `expiryMinutes` after it. */
    readonly now: Date;
  },
): Promise<ProviderStart> {
  const rawName = openPayee(
    deps.crypto,
    input.payee.nameEnvelope,
    input.payee.teamId,
    'bank_account_name',
  );
  const accountNumber = openPayee(
    deps.crypto,
    input.payee.numberEnvelope,
    input.payee.teamId,
    'bank_account_number',
  );
  if (rawName === null || accountNumber === null) return UNUSABLE;
  const name = normalisePayeeName(rawName);
  if (!name.ok) return UNUSABLE;

  const expiresAt = new Date(input.now.getTime() + deps.settings.expiryMinutes * 60_000);
  let result;
  try {
    result = await deps.gateway.createPayment({
      amount: input.amount,
      payee: { name: name.name, accountNumber },
      reference: input.reference,
      redirectUri: input.redirectUri,
      webhookUri: deps.settings.webhookUrl,
      expiresAt,
    });
  } catch {
    // Ambiguous: the provider may or may not have created it. Never retried here; reconcile and the orphan cancel cover it.
    return { kind: 'unavailable' };
  }
  if (result.ok) {
    return {
      kind: 'created',
      providerPaymentId: result.payment.providerPaymentId,
      providerStatus: result.payment.providerStatus,
      providerStatusReason: result.payment.providerStatusReason,
      authorisationUrl: result.authorisationUrl,
      expiresAt,
    };
  }
  return result.kind === 'refused'
    ? { kind: 'refused', reason: REFUSAL_REASON[result.providerCode], code: result.providerCode }
    : { kind: 'unavailable' };
}

export type IntentTable = 'payment_attempts' | 'wallet_top_ups';

const urlContext = (table: IntentTable, intentId: string) => ({
  table,
  column: 'authorisation_url',
  rowId: intentId,
});

/** The consent URL as stored: a FieldCrypto envelope bound to its own row (AAD `sgm:v1:<table>.authorisation_url:<id>`). */
export function sealAuthorisationUrl(
  crypto: FieldCrypto,
  table: IntentTable,
  intentId: string,
  url: string,
): string {
  return crypto.encrypt(url, urlContext(table, intentId));
}

export interface ResumableIntent {
  readonly id: string;
  readonly status: PaymentIntentStatus;
  readonly akahuStatus: string | null;
  readonly expiresAt: Date | null;
  readonly authorisationUrlEnc: string | null;
}

/**
 * The open intent's consent URL, while the payer is still awaited (`READY`) and the link has at least the minimum left; otherwise
 * null (the payer has authorised, the intent is not OPEN, the link is (nearly) expired, or the envelope does not open for this
 * row). The caller decides what null means (processing, or cancel-and-replace).
 */
export function resumeUrl(
  crypto: FieldCrypto,
  table: IntentTable,
  intent: ResumableIntent,
  now: Date,
): string | null {
  if (intent.status !== 'OPEN' || intent.akahuStatus !== 'READY') return null;
  if (intent.expiresAt === null || intent.authorisationUrlEnc === null) return null;
  if (intent.expiresAt.getTime() - now.getTime() < RESUME_MIN_REMAINING_MS) return null;
  try {
    return crypto.decrypt(intent.authorisationUrlEnc, urlContext(table, intent.id));
  } catch (error) {
    if (error instanceof DecryptionError) return null;
    throw error;
  }
}

/** True when an OPEN intent is still awaiting the payer but its link has (nearly) run out: the caller cancels and replaces it. */
export function isExpiredAwaitingPayer(intent: ResumableIntent, now: Date): boolean {
  return (
    intent.status === 'OPEN' &&
    intent.akahuStatus === 'READY' &&
    intent.expiresAt !== null &&
    intent.expiresAt.getTime() - now.getTime() < RESUME_MIN_REMAINING_MS
  );
}

/** `SGM` plus 8 Crockford base32 characters: the statement reference of a top-up (unique, not secret; CR-7). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function newStatementReference(): string {
  return `SGM${Array.from(randomBytes(8), (byte) => CROCKFORD[byte % 32]).join('')}`;
}

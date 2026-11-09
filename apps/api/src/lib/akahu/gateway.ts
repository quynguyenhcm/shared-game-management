/**
 * Provider-neutral payments port (architecture Q1a). Domain code branches on `GatewayOutcome` only; the vendor
 * vocabulary stays inside `lib/akahu` (`status.ts` holds the one mapping table). Amounts are `Money`, never `number`.
 */
import type { KeyObject } from 'node:crypto';
import type { Money } from '@sgm/shared';

export type GatewayOutcome =
  | { readonly kind: 'OPEN'; readonly phase: 'AWAITING_PAYER' | 'IN_FLIGHT' }
  | { readonly kind: 'SUCCEEDED' }
  /** CANCELLED/*, FAILED/{REJECTED, BANK_ERROR, INTERNAL_ERROR}. */
  | { readonly kind: 'NOT_CHARGED' }
  /** FAILED/BANK_ERROR_INDETERMINATE: hold, never "not charged" (A2). */
  | { readonly kind: 'INDETERMINATE' }
  /** Unknown status or reason: leave open and log (A2). */
  | { readonly kind: 'UNRECOGNISED' };

export interface ProviderPayment {
  readonly providerPaymentId: string;
  readonly amount: Money;
  /** Raw provider status and reason, kept for records and logs only. */
  readonly providerStatus: string;
  readonly providerStatusReason: string | null;
  readonly outcome: GatewayOutcome;
}

/** Definite refusals of a create call; `payee_unusable` is the local, pre-call refusal. */
export type CreateRefusalCode =
  | 'invalid_payee'
  | 'invalid_payer'
  | 'single_limit_exceeded'
  | 'bank_limit_exceeded'
  | 'payee_unusable'
  | 'other';

export type CreatePaymentResult =
  | { readonly ok: true; readonly payment: ProviderPayment; readonly authorisationUrl: string }
  | { readonly ok: false; readonly kind: 'refused'; readonly providerCode: CreateRefusalCode }
  /** Timeout, network, 5xx or 429: ambiguous, never retried blindly. */
  | { readonly ok: false; readonly kind: 'unavailable' };

export interface CreatePaymentInput {
  readonly amount: Money;
  /** Plaintext, in memory only for the duration of the call. */
  readonly payee: { readonly name: string; readonly accountNumber: string };
  /** `payment_reference` or top-up reference (at most 12 characters). */
  readonly reference: string;
  readonly redirectUri: string;
  readonly webhookUri: string;
  readonly expiresAt: Date;
}

export interface WebhookKeyResolver {
  /** `'unknown'` is cacheable; a thrown `GatewayUnavailableError` is transient (the webhook answers 503). */
  resolve(keyId: string): Promise<KeyObject | 'unknown'>;
}

export interface PaymentsGateway {
  readonly adapter: 'akahu' | 'fake';
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  /** Throws `GatewayUnavailableError` on a transient failure. */
  getPayment(providerPaymentId: string): Promise<ProviderPayment | 'not_found'>;
  cancelPayment(providerPaymentId: string): Promise<'cancelled' | 'not_cancellable'>;
  readonly webhookKeys: WebhookKeyResolver;
}

export type GatewayUnavailableReason =
  'provider_unavailable' | 'key_fetch_failed' | 'key_fetch_capped';

/** A transient provider failure: callers retry or answer 5xx; nothing is concluded about the payment. */
export class GatewayUnavailableError extends Error {
  readonly reason: GatewayUnavailableReason;

  constructor(reason: GatewayUnavailableReason = 'provider_unavailable', options?: ErrorOptions) {
    super(`payments gateway unavailable: ${reason}`, options);
    this.name = 'GatewayUnavailableError';
    this.reason = reason;
  }
}

/** Thrown by `createPaymentsGateway` for a configuration that must not boot. */
export class GatewayConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayConfigurationError';
  }
}

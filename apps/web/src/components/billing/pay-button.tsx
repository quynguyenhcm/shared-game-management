'use client';

import { startPaymentAction } from '../../lib/billing/actions.ts';
import { AKAHU_LEAVE_LINE, payButtonLabel, type PayKind } from '../../lib/billing/labels.ts';
import { AkahuStartForm } from './akahu-start-form.tsx';

/**
 * Start, retry or continue an Akahu payment for the stored amount: the only thing the browser sends is the payment id and a
 * key. The button is absent (never merely disabled) in every state that forbids a payment, so this is only rendered when
 * `paymentState` offers an action.
 */
export function PayButton({
  paymentId,
  idempotencyKey,
  kind,
  amount,
}: {
  paymentId: string;
  idempotencyKey: string;
  kind: PayKind;
  amount: string;
}) {
  return (
    <AkahuStartForm
      action={startPaymentAction}
      fields={{ paymentId }}
      idempotencyKey={idempotencyKey}
      label={payButtonLabel(kind, amount)}
      trustLines={[AKAHU_LEAVE_LINE]}
    />
  );
}

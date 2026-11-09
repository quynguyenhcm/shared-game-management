import type { BillingType, PaymentStatus } from '@sgm/shared';
import { paymentTag, type TagTone } from '../../lib/billing/labels.ts';

const TONES: Record<TagTone, string> = {
  green: 'border-green-800 bg-green-50 text-green-900',
  slate: 'border-slate-600 bg-slate-50 text-slate-900',
  amber: 'border-amber-800 bg-amber-50 text-amber-900',
  red: 'border-red-800 bg-red-50 text-red-900',
};

/**
 * One source of tag text and tint. The text carries the state and the date ("Overdue since Sat 10 Oct", "Under review"):
 * the tint only reinforces it, so the state is never colour alone.
 */
export function PaymentStatusTag({
  status,
  billingType,
  amount,
  dueDate,
  onHold,
}: {
  status: PaymentStatus;
  billingType: BillingType;
  amount: string;
  dueDate: string;
  onHold: boolean;
}) {
  const tag = paymentTag({ status, billingType, amount, dueDate, onHold });
  return (
    <span
      className={`inline-flex min-w-0 items-center break-words rounded-md border px-2 py-0.5 text-sm font-medium ${TONES[tag.tone]}`}
    >
      {tag.text}
    </span>
  );
}

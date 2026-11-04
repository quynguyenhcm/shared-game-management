'use client';

import { blockPayoutAction } from '../../lib/billing/actions.ts';
import { PAYOUT_BLOCK_REASONS } from '../../lib/billing/labels.ts';
import { FieldError } from '../auth/field-message.tsx';
import { INPUT_CLASS } from '../auth/styles.ts';
import { TextField } from '../auth/text-field.tsx';
import { ConfirmDisclosure } from '../teams/confirm-disclosure.tsx';
import { useManage } from '../teams/manage-context.tsx';
import { useModerationAction } from '../teams/use-moderation-action.ts';
import { useChangeKey } from './use-keys.ts';

/**
 * "Block payments to this team" (A3, CR-14): GLOBAL_ADMIN only, so the page renders it only for that role and the API enforces it
 * (a 403 closes the confirm with the no-access message). An enum reason and an optional Akahu payment id, never free text. There
 * is no unblock here: saving banking again clears the block.
 */
export function PayoutBlockConfirm({
  teamId,
  defaultOpen = false,
}: {
  teamId: string;
  /** Render the panel open on first render (tests). */
  defaultOpen?: boolean;
}) {
  const id = `payout-block-${teamId}`;
  const { state: manage, dispatch } = useManage();
  const { state, formAction, pending } = useModerationAction('payments', blockPayoutAction);
  const changeKey = useChangeKey(state);
  const open = defaultOpen || manage.open.payments === id;
  const reasonError = state?.fieldErrors?.reason?.[0];
  return (
    <ConfirmDisclosure
      id={id}
      triggerId={`${id}-trigger`}
      open={open}
      onOpenChange={(next) => {
        if (next) changeKey.ensure();
        dispatch({ type: next ? 'open' : 'close', section: 'payments', id });
      }}
      triggerLabel="Block payments to this team"
      prompt="Stop payments to this team's bank account? The team admins will be told."
      confirmLabel="Block payments"
      pendingLabel="Blocking…"
      destructive
      pending={pending}
      formAction={formAction}
    >
      <input type="hidden" name="teamId" value={teamId} />
      <input type="hidden" name="changeKey" value={changeKey.key} />
      <div className="flex flex-col gap-1">
        <label htmlFor="field-reason" className="text-base font-medium">
          Reason
        </label>
        {reasonError === undefined ? null : (
          <FieldError id="field-reason-error" message={reasonError} />
        )}
        <select
          id="field-reason"
          name="reason"
          defaultValue=""
          required
          aria-invalid={reasonError === undefined ? undefined : true}
          aria-describedby={reasonError === undefined ? undefined : 'field-reason-error'}
          className={INPUT_CLASS}
        >
          <option value="" disabled>
            Choose a reason
          </option>
          {PAYOUT_BLOCK_REASONS.map((reason) => (
            <option key={reason.value} value={reason.value}>
              {reason.label}
            </option>
          ))}
        </select>
      </div>
      <TextField
        name="akahuPaymentId"
        label="Akahu payment id (optional)"
        hint="Use the payment id exactly as Akahu shows it."
        autoComplete="off"
        spellCheck={false}
        error={state?.fieldErrors?.akahuPaymentId?.[0]}
      />
    </ConfirmDisclosure>
  );
}

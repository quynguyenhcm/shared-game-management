'use client';

import { resolveHoldAction } from '../../lib/billing/actions.ts';
import { TextField } from '../auth/text-field.tsx';
import { ConfirmDisclosure } from '../teams/confirm-disclosure.tsx';
import { useManage } from '../teams/manage-context.tsx';
import { useModerationAction } from '../teams/use-moderation-action.ts';
import { useChangeKey } from './use-keys.ts';

/**
 * "Record what happened" on a held payment (ruling H2: team admins of the payee team, and GLOBAL_ADMIN). The admin looks at the
 * team's bank account and says whether the money arrived. "Yes" may carry the amount that arrived (the API requires it for an
 * amount-mismatch hold and applies the payment only when it equals what was due); "No" never sends one. The API re-reads Akahu
 * first and a definite status wins (CR-26), and a "recorded, not applied" answer is announced as exactly that. Same disclosure,
 * open-slot and status-region contracts as the reminder; no native dialog.
 */
export function HoldResolution({
  teamId,
  paymentId,
  playerName,
  defaultOpen = false,
}: {
  teamId: string;
  paymentId: string;
  playerName: string;
  /** Render the panel open on first render (tests). */
  defaultOpen?: boolean;
}) {
  const id = `hold-${paymentId}`;
  const { state: manage, dispatch } = useManage();
  const { state, formAction, pending } = useModerationAction('payments', resolveHoldAction);
  const changeKey = useChangeKey(state);
  const open = defaultOpen || manage.open.payments === id;
  return (
    <ConfirmDisclosure
      id={id}
      triggerId={`${id}-trigger`}
      open={open}
      onOpenChange={(next) => {
        if (next) changeKey.ensure();
        dispatch({ type: next ? 'open' : 'close', section: 'payments', id });
      }}
      triggerLabel="Record what happened"
      triggerAriaLabel={`Record what happened to ${playerName}'s payment`}
      prompt={`Did ${playerName}'s payment arrive in your bank account?`}
      confirmLabel="Record outcome"
      pendingLabel="Saving…"
      pending={pending}
      formAction={formAction}
    >
      <input type="hidden" name="teamId" value={teamId} />
      <input type="hidden" name="paymentId" value={paymentId} />
      <input type="hidden" name="changeKey" value={changeKey.key} />
      <fieldset className="flex flex-col gap-1">
        <legend className="text-base font-medium">What happened?</legend>
        <label className="flex min-h-11 items-center gap-2 text-base">
          <input type="radio" name="outcome" value="RECEIVED" required />
          Yes, the money arrived
        </label>
        <label className="flex min-h-11 items-center gap-2 text-base">
          <input type="radio" name="outcome" value="NOT_RECEIVED" required />
          No, it didn&apos;t arrive
        </label>
      </fieldset>
      <TextField
        name="observedAmount"
        label="Amount that arrived (NZD)"
        hint="Only if the money arrived: the amount you can see in your bank account."
        autoComplete="off"
        inputMode="decimal"
        spellCheck={false}
        error={state?.fieldErrors?.observedAmount?.[0]}
      />
    </ConfirmDisclosure>
  );
}

'use client';

import type { PaymentStatus } from '@sgm/shared';
import { sendReminderAction } from '../../lib/billing/actions.ts';
import { cooldownText, reminderPrompt, reminderTriggerLabel } from '../../lib/billing/labels.ts';
import { reminderCooldown } from '../../lib/billing/wallet-view.ts';
import { SECONDARY_BUTTON_CLASS } from '../auth/styles.ts';
import { ConfirmDisclosure } from '../teams/confirm-disclosure.tsx';
import { useManage } from '../teams/manage-context.tsx';
import { useModerationAction } from '../teams/use-moderation-action.ts';
import { useChangeKey } from './use-keys.ts';

/**
 * "Send reminder" on an unpaid row (UI/UX Surface 4): the shared confirm disclosure, one open per page (the Payments section's
 * slot in the manage context), `changeKey` generated when the panel opens and kept until a success. It renders nothing for a
 * held payment, a payout-blocked team or a paid one: the API would refuse the reminder (CR-18), so the control is absent. Inside
 * the cooldown (B6) the trigger is a focusable `aria-disabled` button that does nothing, described by when the last one went and
 * when another may go. `now` is the page's clock (a prop, so server and browser render the same words).
 */
export function ReminderConfirm({
  teamId,
  paymentId,
  playerName,
  amount,
  sessionStartsAt,
  status,
  lastReminderAt,
  now,
  held,
  payoutBlocked,
  defaultOpen = false,
}: {
  teamId: string;
  paymentId: string;
  playerName: string;
  /** 2-dp string. */
  amount: string;
  sessionStartsAt: string;
  status: PaymentStatus;
  lastReminderAt: string | null;
  /** ISO instant of the page render. */
  now: string;
  held: boolean;
  payoutBlocked: boolean;
  /** Render the confirmation open on first render (tests). */
  defaultOpen?: boolean;
}) {
  const id = `reminder-${paymentId}`;
  const triggerId = `${id}-trigger`;
  const { state: manage, dispatch } = useManage();
  const { state, formAction, pending } = useModerationAction(
    'payments',
    sendReminderAction,
    `#${triggerId}`,
  );
  const changeKey = useChangeKey(state);

  if (held || payoutBlocked || status === 'PAID') return null;

  const nowDate = new Date(now);
  const label = reminderTriggerLabel(playerName, amount, sessionStartsAt);
  const cooldown = reminderCooldown(lastReminderAt, nowDate);
  if (cooldown.active && lastReminderAt !== null) {
    const describedBy = `${id}-cooldown`;
    return (
      <div className="flex flex-col gap-1">
        <button
          type="button"
          id={triggerId}
          aria-disabled="true"
          aria-label={label}
          aria-describedby={describedBy}
          onClick={(event) => {
            event.preventDefault();
          }}
          className={`${SECONDARY_BUTTON_CLASS} sm:w-auto`}
        >
          Send reminder
        </button>
        <p id={describedBy} className="text-sm">
          {cooldownText(lastReminderAt, nowDate)}
        </p>
      </div>
    );
  }

  const open = defaultOpen || manage.open.payments === id;
  const firstName = playerName.split(' ')[0] ?? playerName;
  return (
    <ConfirmDisclosure
      id={id}
      triggerId={triggerId}
      open={open}
      onOpenChange={(next) => {
        if (next) changeKey.ensure();
        dispatch({ type: next ? 'open' : 'close', section: 'payments', id });
      }}
      triggerLabel="Send reminder"
      triggerAriaLabel={label}
      prompt={reminderPrompt(firstName, amount)}
      confirmLabel="Send reminder"
      pendingLabel="Sending…"
      pending={pending}
      formAction={formAction}
    >
      <input type="hidden" name="teamId" value={teamId} />
      <input type="hidden" name="paymentId" value={paymentId} />
      <input type="hidden" name="changeKey" value={changeKey.key} />
      <input type="hidden" name="firstName" value={firstName} />
      <input type="hidden" name="amount" value={amount} />
    </ConfirmDisclosure>
  );
}

'use client';

import { useState } from 'react';
import { withdrawAction } from '../../lib/registrations/actions.ts';
import {
  CONFIRM_DISMISS,
  LEAVE_PENDING,
  LEAVE_TRIGGER,
  WITHDRAW_CONFIRM,
  WITHDRAW_PENDING,
  WITHDRAW_TRIGGER,
  WITHDRAW_TRIGGER_ARIA,
  withdrawPrompt,
} from '../../lib/registrations/labels.ts';
import { ConfirmDisclosure } from '../teams/confirm-disclosure.tsx';
import { useRegistrationAction } from './registration-shell.tsx';

/**
 * "Withdraw" and "Leave waitlist" on the shared confirm disclosure (never a native dialog). The wording is a pure function of
 * what the API read model said: `late` (the server clock against the deadline), `waitlistLength`, `fee` (`me.estimatedTotal`)
 * and `guestCount`. The action sends only `expectLate`, the player's view of the terms: if the deadline passes while the prompt
 * is open the API answers 409 `cancellation_terms_changed`, the page re-renders with `late` true, and this island re-opens the
 * confirmation so the player reads the late wording and confirms again (R9). A 5xx keeps it open, with the outage in the status
 * region.
 */
export function WithdrawConfirm({
  teamId,
  sessionId,
  kind,
  late,
  waitlistLength,
  fee,
  guestCount,
  defaultOpen = false,
}: {
  teamId: string;
  sessionId: string;
  kind: 'withdraw' | 'leave';
  late: boolean;
  waitlistLength: number;
  fee: string | null;
  guestCount: number;
  /** Render the confirmation open on first render (tests). */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // A failed result keeps the confirmation open; the 409 re-opens it if the player had closed it meanwhile.
  const { dispatch, pending } = useRegistrationAction(withdrawAction, (result) => {
    if (result.reopenConfirm === true) setOpen(true);
  });

  const leaving = kind === 'leave';
  return (
    <ConfirmDisclosure
      id={`${kind}-registration`}
      open={open}
      onOpenChange={setOpen}
      triggerLabel={leaving ? LEAVE_TRIGGER : WITHDRAW_TRIGGER}
      {...(leaving ? {} : { triggerAriaLabel: WITHDRAW_TRIGGER_ARIA })}
      prompt={withdrawPrompt({ kind, late, waitlistLength, fee, guestCount })}
      confirmLabel={leaving ? LEAVE_TRIGGER : WITHDRAW_CONFIRM}
      pendingLabel={leaving ? LEAVE_PENDING : WITHDRAW_PENDING}
      dismissLabel={CONFIRM_DISMISS}
      destructive
      pending={pending}
      formAction={(formData) => {
        if (!pending) dispatch(formData);
      }}
    >
      <input type="hidden" name="teamId" value={teamId} />
      <input type="hidden" name="sessionId" value={sessionId} />
      <input type="hidden" name="intent" value={kind} />
      <input type="hidden" name="expectLate" value={late ? 'true' : 'false'} />
      <input type="hidden" name="grouped" value={guestCount > 0 ? '1' : '0'} />
    </ConfirmDisclosure>
  );
}

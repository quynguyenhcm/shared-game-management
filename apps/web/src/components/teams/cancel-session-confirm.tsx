'use client';

import type { SessionResponse } from '@sgm/shared';
import { cancelSessionAction } from '../../lib/teams/sessions-actions.ts';
import { cancelPrompt } from '../../lib/teams/sessions-view.ts';
import { InlineConfirm } from './inline-confirm.tsx';

/**
 * "Cancel session" (UI/UX cancel prompts): an `InlineConfirm` whose prompt says what is true of this session,
 * that it is a draft or a published session, one date of a series, and how many players are registered (we
 * do not email them, so the admin is told to). Its dismiss label is never "Cancel" (it sits beside "Cancel session").
 */
export function CancelSessionConfirm({
  teamId,
  session,
  defaultOpen = false,
}: {
  teamId: string;
  session: Pick<
    SessionResponse,
    'id' | 'status' | 'version' | 'date' | 'recurringRuleId' | 'activeRegistrationCount'
  >;
  defaultOpen?: boolean;
}) {
  const copy = cancelPrompt({
    status: session.status === 'DRAFT' ? 'DRAFT' : 'PUBLISHED',
    seriesDate: session.recurringRuleId === null ? null : session.date,
    activeRegistrationCount: session.activeRegistrationCount,
  });
  return (
    <InlineConfirm
      id="cancel-session"
      section="session"
      action={cancelSessionAction}
      fields={{
        teamId,
        sessionId: session.id,
        expectedVersion: String(session.version),
        wasDraft: String(session.status === 'DRAFT'),
      }}
      triggerLabel={copy.triggerLabel}
      prompt={copy.prompt}
      confirmLabel={copy.confirmLabel}
      pendingLabel="Cancelling…"
      dismissLabel={copy.dismissLabel}
      destructive
      defaultOpen={defaultOpen}
    />
  );
}

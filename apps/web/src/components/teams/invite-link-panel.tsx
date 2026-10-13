'use client';

import type { TeamVisibility } from '@sgm/shared';
import { useRef, useState } from 'react';
import { regenerateInviteAction } from '../../lib/teams/actions.ts';
import { COPIED, COPY_FAILED, REGENERATE_PROMPT, inviteIntro } from '../../lib/teams/labels.ts';
import { INPUT_CLASS, SECONDARY_BUTTON_CLASS } from '../auth/styles.ts';
import { InlineConfirm } from './inline-confirm.tsx';

/**
 * The invite link: the full URL in a read-only field (selected on focus, so it can be copied by hand),
 * "Copy link" through the Clipboard API with a select-the-field fallback, and "Generate new link" behind the
 * inline confirm. After a regeneration the page re-renders with the new URL and focus moves to the field.
 */
export function InviteLinkPanel({
  teamId,
  url,
  visibility,
}: {
  teamId: string;
  url: string;
  visibility: TeamVisibility;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [copyStatus, setCopyStatus] = useState('');

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url);
      setCopyStatus(COPIED);
    } catch {
      input.current?.select();
      setCopyStatus(COPY_FAILED);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-base">{inviteIntro(visibility)}</p>
      <div className="flex flex-col gap-1">
        <label htmlFor="invite-url" className="text-base font-medium">
          Invite link
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            ref={input}
            id="invite-url"
            type="text"
            readOnly
            value={url}
            onFocus={(event) => {
              event.currentTarget.select();
            }}
            className={INPUT_CLASS}
          />
          <button
            type="button"
            onClick={() => {
              void copy();
            }}
            className={`${SECONDARY_BUTTON_CLASS} sm:w-auto sm:shrink-0`}
          >
            Copy link
          </button>
        </div>
      </div>
      <div role="status" className="text-base">
        {copyStatus === '' ? null : <p className="font-medium">{copyStatus}</p>}
      </div>
      <InlineConfirm
        id="regenerate"
        kind="regenerate"
        action={regenerateInviteAction}
        fields={{ teamId }}
        triggerLabel="Generate new link"
        prompt={REGENERATE_PROMPT}
        confirmLabel="Generate new link"
        pendingLabel="Generating…"
        focusOnSuccess="#invite-url"
      />
    </div>
  );
}

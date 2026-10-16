import type { BankingResponse } from '@sgm/shared';
import { removeBankingAction } from '../../lib/teams/banking-actions.ts';
import {
  BANKING_REMOVE_PROMPT,
  BANKING_SECTION_INTRO,
  BANKING_SECTION_TITLE,
  editHref,
  formatLastChanged,
  hasSavedBanking,
} from '../../lib/teams/banking-view.ts';
import { SECONDARY_BUTTON_CLASS } from '../auth/styles.ts';
import { BankingForm } from './banking-form.tsx';
import { InlineConfirm } from './inline-confirm.tsx';
import { ManageSection } from './manage-section.tsx';

/**
 * The banking section (R6): nothing saved, or unreadable details (R7), shows the form directly; a readable
 * saved block shows a read-only summary with "Change banking details" (`?edit=banking`) and, only in that
 * view, "Remove banking details". The full account number is never rendered: only "ending {last4}".
 */
export function BankingSection({
  teamId,
  banking,
  editing,
  changeKey,
  returnTo,
}: {
  teamId: string;
  banking: BankingResponse['banking'];
  /** `?edit=banking` was requested. */
  editing: boolean;
  changeKey: string;
  returnTo: string | undefined;
}) {
  const saved = hasSavedBanking(banking);
  const lastChanged = formatLastChanged(banking.lastChanged);
  return (
    <ManageSection id="banking" title={BANKING_SECTION_TITLE}>
      <p className="text-base">{BANKING_SECTION_INTRO}</p>
      {saved && !editing ? (
        <div className="flex max-w-xl flex-col gap-4">
          <dl className="grid grid-cols-1 gap-y-1 rounded-md border border-slate-300 p-4 sm:grid-cols-[max-content_1fr] sm:gap-x-6">
            <dt className="font-medium">Account name</dt>
            <dd className="mb-2 break-words sm:mb-0">{banking.accountName ?? ''}</dd>
            <dt className="font-medium">Account number</dt>
            <dd>{`ending ${banking.accountNumberLast4 ?? ''}`}</dd>
          </dl>
          {lastChanged === null ? null : <p className="text-sm text-slate-700">{lastChanged}</p>}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
            <a
              href={editHref(teamId, 'banking', returnTo)}
              className={`${SECONDARY_BUTTON_CLASS} sm:w-auto`}
            >
              Change banking details
            </a>
            <InlineConfirm
              id="remove-banking"
              section="banking"
              action={removeBankingAction}
              fields={{ teamId, ...(returnTo === undefined ? {} : { returnTo }) }}
              triggerLabel="Remove banking details"
              prompt={BANKING_REMOVE_PROMPT}
              confirmLabel="Remove banking details"
              pendingLabel="Removing…"
              destructive
            />
          </div>
        </div>
      ) : (
        <BankingForm
          teamId={teamId}
          changeKey={changeKey}
          savedAccountName={saved ? (banking.accountName ?? '') : ''}
          requireNumber={!saved}
          wasConfigured={saved}
          returnTo={returnTo}
          editing={saved && editing}
        />
      )}
    </ManageSection>
  );
}

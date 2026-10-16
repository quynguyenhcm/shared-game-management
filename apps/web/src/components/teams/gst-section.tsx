import type { GstResponse } from '@sgm/shared';
import {
  GST_SECTION_TITLE,
  editHref,
  gstSummaryRows,
  hasSavedGst,
} from '../../lib/teams/banking-view.ts';
import { SECONDARY_BUTTON_CLASS } from '../auth/styles.ts';
import { GstForm } from './gst-form.tsx';
import { ManageSection } from './manage-section.tsx';

/**
 * The GST section (R2, R6): nothing saved shows the form directly; otherwise a read-only summary with
 * "Change GST settings" (`?edit=gst`). The GST number is public (printed on invoices), so it is shown in
 * full, formatted `123-456-789`.
 */
export function GstSection({
  teamId,
  gst,
  editing,
  returnTo,
}: {
  teamId: string;
  gst: GstResponse['gst'];
  /** `?edit=gst` was requested. */
  editing: boolean;
  returnTo: string | undefined;
}) {
  const saved = hasSavedGst(gst);
  return (
    <ManageSection id="gst" title={GST_SECTION_TITLE}>
      {saved && !editing ? (
        <div className="flex max-w-xl flex-col gap-4">
          <dl className="grid grid-cols-1 gap-y-1 rounded-md border border-slate-300 p-4 sm:grid-cols-[max-content_1fr] sm:gap-x-6">
            {gstSummaryRows(gst).flatMap((row) => [
              <dt key={`${row.label}-label`} className="font-medium">
                {row.label}
              </dt>,
              <dd key={`${row.label}-value`} className="mb-2 break-words sm:mb-0">
                {row.value}
                {row.note === undefined ? null : (
                  <span className="block text-sm text-slate-700">{row.note}</span>
                )}
              </dd>,
            ])}
          </dl>
          <a
            href={editHref(teamId, 'gst', returnTo)}
            className={`${SECONDARY_BUTTON_CLASS} sm:w-auto sm:self-start`}
          >
            Change GST settings
          </a>
        </div>
      ) : (
        <GstForm
          teamId={teamId}
          savedRegistered={gst.gstRegistered}
          savedNumber={gst.gstNumber}
          returnTo={returnTo}
          editing={saved && editing}
        />
      )}
    </ManageSection>
  );
}

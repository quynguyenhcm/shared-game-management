import {
  BANKING_FIELD_MESSAGES,
  GST_RATE_BPS,
  PutBankingRequest,
  PutGstRequest,
  formatIrdNumber,
  gstFraction,
  safeReturnTo,
  type BankingResponse,
  type GstResponse,
} from '@sgm/shared';
import { z } from 'zod';
import { buildUrl } from '../auth/landing.ts';
import type { FieldErrors } from '../auth/validation.ts';
import {
  NOT_FOUND_HEADING,
  NO_ACCESS_HEADING,
  OUTAGE_MESSAGE,
  formatManageDate,
} from './labels.ts';

/**
 * Pure view rules and copy of the banking page (UI/UX copy table as amended by the task's Creative
 * Reconciliation: R1 bank account only, no Akahu wording; R2 one GST number; R3 blocked; R6 summary then
 * Change; R7 unreadable; R8 audit line). Kept free of React so each rule is unit-tested once.
 */

type BankingView = BankingResponse['banking'];
type GstView = GstResponse['gst'];

// ---------------------------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------------------------

export const BANKING_INTRO =
  'Only team admins can see this page. We show only part of your account number.';
export const BANKING_SECTION_TITLE = 'Bank account';
export const BANKING_SECTION_INTRO =
  'These details let your team take payments for paid sessions. The name and number are saved together.';
export const GST_SECTION_TITLE = 'GST';
export const ACCOUNT_NAME_HINT = 'The name on the bank account. Up to 100 characters.';
export const ACCOUNT_NUMBER_HINT_FIRST =
  'Format 00-0000-0000000-00. Hyphens and spaces are optional.';
export const ACCOUNT_NUMBER_HINT_SAVED =
  'Leave blank to keep the saved value. To replace it, use the format 00-0000-0000000-00.';
export const GST_NUMBER_HINT = 'This is your IRD number.';
export const GST_TOGGLE_LABEL = 'This team is registered for GST';
/** Shown only while GST is off and a number is saved: the number is personal data for a sole trader. */
export const GST_CLEAR_LABEL = 'Remove the saved GST number';
export const GST_CLEAR_HINT = "It isn't used while GST is off. You can add it again later.";
export const BANKING_REMOVE_PROMPT =
  "Remove banking details? Paid sessions can't be published until you add them again.";
/** The API's `banking_in_use` wording: it also covers unsettled payments (architecture AC-ERROR-10). */
export const BANKING_IN_USE_MESSAGE =
  'Cancel or complete your published paid sessions, and wait for unpaid payments to be settled, before removing the banking details.';
export const REMOVE_OUTAGE_MESSAGE =
  'Something went wrong on our side and nothing was removed. Try again in a minute.';
export const BACK_TO_SESSION = 'Back to your session';

const EMAIL_LINE = "We've emailed the team's admins about this change.";

// ---------------------------------------------------------------------------------------------
// Status line (text-led, never colour alone)
// ---------------------------------------------------------------------------------------------

export type BankingStatusKind = 'not_set_up' | 'ready' | 'blocked' | 'unreadable';

export interface BankingStatus {
  kind: BankingStatusKind;
  /** The bold lead ("Not set up."). */
  lead: string;
  body: string;
}

/** Unreadable (R7) wins over blocked (R3), which wins over configured. */
export function bankingStatus(
  banking: Pick<
    BankingView,
    'isPayoutConfigured' | 'payoutBlocked' | 'unreadable' | 'accountNumberLast4'
  >,
): BankingStatus {
  if (banking.unreadable) {
    return {
      kind: 'unreadable',
      lead: 'Needs attention.',
      body: "We couldn't read your saved bank details. Enter the account name and number again to fix this.",
    };
  }
  if (banking.payoutBlocked) {
    const account =
      banking.accountNumberLast4 === null
        ? 'the saved account'
        : `the account ending ${banking.accountNumberLast4}`;
    return {
      kind: 'blocked',
      lead: 'Needs attention.',
      body: `Payments to ${account} failed. Check the account number and save it again.`,
    };
  }
  if (banking.isPayoutConfigured) {
    return { kind: 'ready', lead: 'Set up.', body: 'Paid sessions can be published.' };
  }
  return {
    kind: 'not_set_up',
    lead: 'Not set up.',
    body: "Paid sessions can't be published until you add your bank account details.",
  };
}

// ---------------------------------------------------------------------------------------------
// Notices (`?notice=` codes in, fixed text out)
// ---------------------------------------------------------------------------------------------

export interface BankingNotice {
  lines: string[];
}

/**
 * The banner for a successful write. The account ending comes from the fresh page load, never the URL. The
 * change-email line is added only where a change always happened (first save, new number, removal): a
 * name-only save of identical values sends nothing, so that notice does not promise an email.
 */
export function bankingNotice(
  code: string | null | undefined,
  context: { last4?: string | null },
): BankingNotice | null {
  switch (code) {
    case 'banking_saved':
      return { lines: ['Banking details saved. Paid sessions can now be published.', EMAIL_LINE] };
    case 'banking_updated':
      return { lines: ['Banking details updated.'] };
    case 'banking_account_changed':
      return context.last4 === undefined || context.last4 === null
        ? { lines: ['Banking details updated.'] }
        : {
            lines: [
              `Banking details updated. Payments now go to the account ending ${context.last4}.`,
              EMAIL_LINE,
            ],
          };
    case 'banking_removed':
      return {
        lines: [
          "Banking details removed. Paid sessions can't be published until you add them again.",
          EMAIL_LINE,
        ],
      };
    case 'banking_nothing_removed':
      // The DELETE found nothing saved (a double click, a second tab): nobody was emailed.
      return { lines: ['There were no banking details to remove.'] };
    case 'gst_saved':
      return { lines: ['GST settings saved.'] };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// URLs: edit mode and the returnTo hand-off (ADR 0016)
// ---------------------------------------------------------------------------------------------

export type EditSection = 'banking' | 'gst';

/** Edit mode is URL state from a closed list; anything else is ignored. */
export function parseEditParam(raw: string | null | undefined): EditSection | null {
  return raw === 'banking' || raw === 'gst' ? raw : null;
}

export function bankingPath(teamId: string): string {
  return `/teams/${teamId}/manage/banking`;
}

export function bankingPageUrl(input: {
  teamId: string;
  edit?: EditSection | null | undefined;
  notice?: string | undefined;
  returnTo?: string | undefined;
}): string {
  return buildUrl(bankingPath(input.teamId), {
    edit: input.edit,
    notice: input.notice,
    returnTo: input.returnTo,
  });
}

/** The "Change ..." link: edit mode in the URL, landing on the section heading, with returnTo carried. */
export function editHref(teamId: string, section: EditSection, returnTo?: string): string {
  return `${bankingPageUrl({ teamId, edit: section, returnTo })}#${section}`;
}

/** "Cancel" in edit mode: back to the summary (edit cleared), returnTo kept. */
export function viewHref(teamId: string, section: EditSection, returnTo?: string): string {
  return `${bankingPageUrl({ teamId, returnTo })}#${section}`;
}

/**
 * The hand-off `returnTo` (ADR 0016): a `safeReturnTo` path that stays under this team's own
 * `/teams/<id>/` and is not the banking page itself. Anything else is dropped silently.
 */
export function bankingReturnTo(
  teamId: string,
  raw: string | null | undefined,
): string | undefined {
  const safe = safeReturnTo(raw);
  const prefix = `/teams/${teamId}/`;
  if (!safe.startsWith(prefix)) return undefined;
  const pathname = (safe.split(/[?#]/, 1)[0] ?? '').replace(/\/$/, '');
  return pathname === bankingPath(teamId) ? undefined : safe;
}

// ---------------------------------------------------------------------------------------------
// Validation (the shared contracts, so web and API show the same words; the API stays the authority)
// ---------------------------------------------------------------------------------------------

type Values = Record<string, string | undefined>;

/** Zod issues to the `fieldErrors` shape the forms render. */
export function fieldErrorsOf(error: z.ZodError): FieldErrors {
  const flat = z.flattenError(error).fieldErrors as Record<string, string[] | undefined>;
  const errors: FieldErrors = {};
  for (const [name, messages] of Object.entries(flat)) {
    if (messages !== undefined && messages.length > 0) errors[name] = messages;
  }
  return errors;
}

/**
 * A blank account number is valid only when a saved number exists to keep (`requireNumber` false). An
 * unreadable saved number counts as none (R7), so the caller passes `requireNumber: true` then.
 */
export function validateBankingForm(
  values: Values,
  options: { requireNumber: boolean },
): FieldErrors {
  const result = PutBankingRequest.omit({ changeKey: true }).safeParse({
    accountName: values.accountName ?? '',
    accountNumber: values.accountNumber ?? '',
  });
  const errors = result.success ? {} : fieldErrorsOf(result.error);
  if (options.requireNumber && (values.accountNumber ?? '').trim() === '') {
    errors.accountNumber = [BANKING_FIELD_MESSAGES.accountNumberRequired];
  }
  return errors;
}

/** Registering needs a GST number: typed now, or already saved (a blank field keeps the saved one). */
export function validateGstForm(
  values: Values,
  options: { hasSavedGstNumber: boolean },
): FieldErrors {
  const registered = values.gstRegistered === 'on';
  // The change key is a hidden per-render value the API checks; there is nothing to validate in the browser.
  const result = PutGstRequest.omit({ changeKey: true }).safeParse({
    gstRegistered: registered,
    ...(values.gstNumber === undefined ? {} : { gstNumber: values.gstNumber }),
  });
  const errors = result.success ? {} : fieldErrorsOf(result.error);
  if (
    registered &&
    result.success &&
    result.data.gstNumber === undefined &&
    !options.hasSavedGstNumber
  ) {
    errors.gstNumber = [BANKING_FIELD_MESSAGES.gstNumberRequired];
  }
  return errors;
}

/**
 * The banner lines for a save's page-level error code. Anything that is not "no access" or "no such
 * team" is the generic outage line: the typed values are still in the form (AC-ERROR-13).
 */
export function bankingErrorLines(code: string): string[] {
  if (code === 'forbidden') return [NO_ACCESS_HEADING];
  if (code === 'not_found') return [NOT_FOUND_HEADING];
  return [OUTAGE_MESSAGE];
}

// ---------------------------------------------------------------------------------------------
// GST copy and summary rows
// ---------------------------------------------------------------------------------------------

const GST_FORWARD_ONLY =
  'Changing this setting only affects payments taken after you save; existing payments and invoices keep the GST treatment they were charged with.';

/** Helper text split by toggle state; the fraction is derived from the rate constant, never typed. */
export function gstHelperText(registered: boolean): string {
  if (!registered) return `Turn this on if your team is registered for GST. ${GST_FORWARD_ONLY}`;
  const { numerator, denominator } = gstFraction(GST_RATE_BPS);
  return `Players' prices include GST. GST is worked out as ${numerator}/${denominator} of the price. ${GST_FORWARD_ONLY}`;
}

export interface SummaryRow {
  label: string;
  value: string;
  note?: string;
}

/** The read-only GST summary: a saved number stays listed (formatted) while GST is off, labelled as unused. */
export function gstSummaryRows(gst: Pick<GstView, 'gstRegistered' | 'gstNumber'>): SummaryRow[] {
  const rows: SummaryRow[] = [
    { label: 'GST', value: gst.gstRegistered ? 'Registered' : 'Not registered' },
  ];
  if (gst.gstNumber !== null) {
    rows.push(
      gst.gstRegistered
        ? { label: 'GST number', value: formatIrdNumber(gst.gstNumber) }
        : {
            label: 'Saved GST number',
            value: formatIrdNumber(gst.gstNumber),
            note: 'Not used while GST is off.',
          },
    );
  }
  return rows;
}

/** Is there anything saved for GST? Nothing saved shows the form directly (R6). */
export function hasSavedGst(gst: Pick<GstView, 'gstRegistered' | 'gstNumber'>): boolean {
  return gst.gstRegistered || gst.gstNumber !== null;
}

/** Is there a readable saved banking block to summarise? Unreadable details have no summary (R7). */
export function hasSavedBanking(
  banking: Pick<BankingView, 'unreadable' | 'accountNumberLast4'>,
): boolean {
  return !banking.unreadable && banking.accountNumberLast4 !== null;
}

/** "Last changed by {name} on {date}" (R8), or null when there is no audit stamp. */
export function formatLastChanged(lastChanged: BankingView['lastChanged']): string | null {
  if (lastChanged === null) return null;
  const when = formatManageDate(lastChanged.at);
  return lastChanged.by === null
    ? `Last changed on ${when}`
    : `Last changed by ${lastChanged.by.fullName} on ${when}`;
}

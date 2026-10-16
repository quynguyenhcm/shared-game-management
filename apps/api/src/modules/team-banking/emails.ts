/**
 * The banking-changed notice (R8): sent to every approved admin, the actor included, when payout details are saved
 * or removed. Plain text. It says who changed what and when and links to the page; it carries no account name, no
 * account digits and no last-4 (the Creative Reconciliation rules these out), only the names of the fields.
 */
import { formatNzDateTime } from '@sgm/shared';
import type { EmailMessage } from '../../lib/notifications/notifier.ts';

export type BankingChangedField = 'accountName' | 'accountNumber';

export interface BankingChangedEmailInput {
  /** The recipient's normalised email: the only recipient. */
  readonly to: string;
  readonly recipientName: string;
  readonly teamName: string;
  readonly teamId: string;
  readonly actorName: string;
  readonly kind: 'saved' | 'removed';
  /** Which fields a save changed (names only); empty for a removal or a block-clearing re-save. */
  readonly changedFields: readonly BankingChangedField[];
  readonly when: Date;
  /** `config.auth.webBaseUrl`: origin of the web app, no trailing slash. */
  readonly webBaseUrl: string;
  /** The per-render uuid of the change (a replay of the same key never sends a second email). */
  readonly changeKey: string;
  readonly recipientId: string;
}

const FIELD_LABEL: Record<BankingChangedField, string> = {
  accountName: 'account name',
  accountNumber: 'account number',
};

/** A name is user input: fold any line breaks so it cannot forge extra lines in the body. */
const fold = (text: string): string => text.replace(/\s+/g, ' ').trim();

export function buildBankingChangedEmail(input: BankingChangedEmailInput): EmailMessage {
  const team = fold(input.teamName);
  const actor = fold(input.actorName);
  const when = formatNzDateTime(input.when);
  const what =
    input.kind === 'removed'
      ? 'removed the bank account details'
      : input.changedFields.length === 0
        ? 'saved the bank account details again'
        : `changed the ${input.changedFields.map((field) => FIELD_LABEL[field]).join(' and ')}`;
  const text = [
    `Hi ${fold(input.recipientName)},`,
    '',
    `${actor} ${what} for ${team} on ${when} (New Zealand time).`,
    '',
    'Review the banking details:',
    `${input.webBaseUrl}/teams/${input.teamId}/manage/banking`,
    '',
    "If you weren't expecting this change, tell your other team admins and check the details now.",
    '',
    'Shared Game Management',
    '',
  ].join('\n');
  return {
    to: input.to,
    subject: 'Bank account details changed for your team',
    text,
    idempotencyKey: `banking-changed:${input.teamId}:${input.changeKey}:${input.recipientId}`,
    tags: { template: 'banking-changed' },
  };
}

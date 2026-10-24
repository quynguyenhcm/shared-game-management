/**
 * The "bank account needed" notice (AC-ASYNC-3, ADR 0016 recurrence contract points 2 and 5): sent to every approved admin of a
 * team whose paid series sessions were saved as drafts, at most once per rule per NZ week. Plain text. It names the team and
 * links to the banking page and the series page. It carries no amounts, no bank values and no member names.
 */
import type { EmailMessage } from '../../lib/notifications/notifier.ts';

export interface PayoutMissingEmailInput {
  /** The recipient's address: the only recipient. */
  readonly to: string;
  readonly recipientId: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly ruleId: string;
  /** Monday of the run's NZ week (`YYYY-MM-DD`): the claim window. */
  readonly windowStart: string;
  /** `config.auth.webBaseUrl`: origin of the web app, no trailing slash. */
  readonly webBaseUrl: string;
}

/** A team name is user input: fold any line breaks so it cannot forge extra lines in the body or the subject. */
const fold = (text: string): string => text.replace(/\s+/g, ' ').trim();

export function buildPayoutMissingEmail(input: PayoutMissingEmailInput): EmailMessage {
  const team = fold(input.teamName);
  const base = `${input.webBaseUrl}/teams/${input.teamId}/manage`;
  const text = [
    'Hi,',
    '',
    `Some sessions in a recurring series for ${team} were saved as drafts because your team's bank account isn't set up. ` +
      "Members can't register for them yet.",
    '',
    'Set up banking and GST, and the drafts are published automatically:',
    `${base}/banking`,
    '',
    'See the series and its drafts:',
    `${base}/sessions/series/${input.ruleId}`,
    '',
    "You'll get this reminder at most once a week while drafts are waiting.",
    '',
    'Shared Game Management',
    '',
  ].join('\n');
  return {
    to: input.to,
    subject: `Sessions not published for ${team}: bank account needed`,
    text,
    // The key names the rule and the week (AC-ASYNC-3) and the recipient, so every admin gets one and a replay sends none.
    idempotencyKey: `payout-missing:${input.ruleId}:${input.windowStart}:${input.recipientId}`,
    tags: { template: 'payout-missing' },
  };
}

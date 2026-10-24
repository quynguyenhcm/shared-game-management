/**
 * The two registration emails the allocator enqueues in the placing transaction (P5): the promotion ("You're in") and the
 * auto-enrol notice (R17). Plain text. They carry the recipient address (the job's `to`, as for every email) and
 * session facts; no amount other than the recipient's own per-person fee, no other player, no guest name.
 *
 * Phase 2 supplies exactly what the allocator needs to enqueue; the Phase 3 routes own any later copy refinement.
 */
import {
  formatNZD,
  formatNzTime,
  toIsoInstant,
  unitFee,
  type FeePerson,
  type SessionFeeColumns,
} from '@sgm/shared';
import type { EmailMessage } from '../../lib/notifications/notifier.ts';

export interface RegistrationEmailInput {
  readonly to: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly sessionId: string;
  readonly registrationId: string;
  readonly location: string;
  readonly address: string;
  readonly startsAt: Date;
  readonly cancellationDeadline: Date;
  /** The instant of the placement (`now` of the transaction): decides "deadline passed" and the idempotency key. */
  readonly at: Date;
  readonly fees: SessionFeeColumns;
  /** The pricing person for the recipient's own per-person fee; null when it cannot be known. */
  readonly person: FeePerson | null;
  /** `config.auth.webBaseUrl`: origin of the web app, no trailing slash. */
  readonly webBaseUrl: string;
}

const NZ_DAY = new Intl.DateTimeFormat('en-NZ', {
  timeZone: 'Pacific/Auckland',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

/** "Wed 7 Oct" in Pacific/Auckland. */
export function formatNzDay(instant: Date): string {
  const part = Object.fromEntries(NZ_DAY.formatToParts(instant).map((p) => [p.type, p.value]));
  return `${part.weekday} ${part.day} ${part.month}`;
}

/** A name or address is user input: fold line breaks so it cannot forge extra lines in the body or the subject. */
const fold = (text: string): string => text.replace(/\s+/g, ' ').trim();

function sessionLines(input: RegistrationEmailInput): string[] {
  const when = `${formatNzDay(input.startsAt)}, ${formatNzTime(input.startsAt)}`;
  const fee = input.person === null ? null : unitFee(input.fees, input.person);
  const feeLine =
    fee === null
      ? []
      : input.fees.pricing === 'FLAT'
        ? [`Fee: ${formatNZD(fee)} per person, charged after the game.`]
        : [`Your fee: ${formatNZD(fee)}, charged after the game.`];
  return [`When: ${when}`, `Where: ${fold(input.location)}, ${fold(input.address)}`, ...feeLine];
}

const freeCancellationLine = (input: RegistrationEmailInput): string =>
  `Free cancellation until ${formatNzDay(input.cancellationDeadline)}, ${formatNzTime(input.cancellationDeadline)}.`;

const deadlineLine = (input: RegistrationEmailInput): string =>
  input.at.getTime() <= input.cancellationDeadline.getTime()
    ? freeCancellationLine(input)
    : "The free cancellation deadline has passed. If you can't play, withdraw on the session page: you won't be charged if someone from the waitlist takes your place, otherwise the fee applies.";

const link = (input: RegistrationEmailInput): string =>
  `${input.webBaseUrl}/teams/${input.teamId}/sessions/${input.sessionId}`;

/** AC-ASYNC-1: a waitlisted player was promoted. One key per promotion, so a replay sends once. */
export function buildPromotionEmail(input: RegistrationEmailInput): EmailMessage {
  const team = fold(input.teamName);
  const text = [
    'Hi,',
    '',
    `A place opened up and you're in for ${team} on ${formatNzDay(input.startsAt)}.`,
    '',
    ...sessionLines(input),
    deadlineLine(input),
    '',
    'See the session and manage your place:',
    link(input),
    '',
    'Shared Game Management',
    '',
  ].join('\n');
  return {
    to: input.to,
    subject: `You're in: ${team}, ${formatNzDay(input.startsAt)}`,
    text,
    idempotencyKey: `registration-promoted:${input.registrationId}:${input.at.getTime()}`,
    tags: { template: 'registration-promoted' },
  };
}

/** R17: a member was placed by Auto Enroll (confirmed or waitlisted). The key carries the placement instant. */
export function buildAutoEnrolEmail(
  input: RegistrationEmailInput & { readonly status: 'CONFIRMED' | 'WAITLISTED' },
): EmailMessage {
  const team = fold(input.teamName);
  const day = formatNzDay(input.startsAt);
  const confirmed = input.status === 'CONFIRMED';
  const text = [
    'Hi,',
    '',
    confirmed
      ? `You've been added to ${team} on ${day}: you're in.`
      : `You've been added to the waitlist for ${team} on ${day}. We'll email you if a place opens up.`,
    '',
    ...sessionLines(input),
    freeCancellationLine(input),
    '',
    `Your team admin turned on Auto Enroll for you. Withdraw on the session page if you can't play.`,
    '',
    link(input),
    '',
    'Shared Game Management',
    '',
  ].join('\n');
  return {
    to: input.to,
    subject: confirmed
      ? `You've been added to ${team}, ${day}`
      : `You've been added to the waitlist for ${team}, ${day}`,
    text,
    idempotencyKey: `auto-enrol:${input.registrationId}:${toIsoInstant(input.at)}`,
    tags: { template: 'registration-auto-enrol' },
  };
}

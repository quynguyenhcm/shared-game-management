/**
 * Response and query contracts of the player dashboard's two cross-team read models (player-dashboard Phase 1), shared by the
 * Fastify routes and the web api-client:
 *
 *   GET /me/sessions/open ...... the upcoming PUBLISHED sessions of the teams where the caller is APPROVED, with the caller's own fee
 *   GET /me/registrations ...... every registration of the caller (Upcoming, then Past 20 per page), with its payment if one exists
 *
 * Both are read-only and scoped to the authenticated caller. Money crosses the wire as a 2-dp `MoneyString`, instants as ISO-8601
 * UTC strings; all formatting (dates in Pacific/Auckland, fee and place wording) stays in the web. Responses carry names of the
 * caller's own teams and places only: never another player's name, an email address or a bank detail.
 */
import { z } from 'zod';
import { moneyStringSchema } from '../money/zod.ts';
import {
  BillingType,
  PaymentStatus,
  PricingType,
  RegistrationStatus,
  SessionStatus,
  SkillTier,
} from '../types/enums.ts';
import { RegistrationBlockedReason } from './registrations.ts';

/** Open sessions are returned in one page of at most this many (soonest first); `hasMore` says there are more. */
export const OPEN_SESSIONS_LIMIT = 50;
/** `Past` registrations arrive this many at a time. */
export const REGISTRATIONS_PAGE_SIZE = 20;

const isoInstant = z.iso.datetime();
const count = z.number().int().min(0);
const nullableMoney = moneyStringSchema.nullable();

/** The caller's own registration in a listed session (WITHDRAWN rows read as no registration here). */
export const OpenSessionMe = z.strictObject({
  status: z.enum(['CONFIRMED', 'WAITLISTED']),
  /** `1 + the waiting parties ahead`; null unless WAITLISTED. */
  waitlistRank: z.number().int().min(1).nullable(),
});

export const OpenSessionRow = z.strictObject({
  sessionId: z.uuid(),
  teamId: z.uuid(),
  teamName: z.string(),
  location: z.string(),
  address: z.string(),
  startsAt: isoInstant,
  endsAt: isoInstant.nullable(),
  pricingStructure: z.enum(PricingType),
  /** The caller's own per-person fee at the pricing snapshot (or their current sex and level); null when not priced yet. */
  unitFee: nullableMoney,
  /** The skill tier the fee is priced at; null unless the session is BY_SKILL_LEVEL. */
  feeLevel: z.enum(SkillTier).nullable(),
  publicCapacity: count,
  seatsLeft: count,
  waitlistLength: count,
  me: OpenSessionMe.nullable(),
  canRegister: z.boolean(),
  blockedReason: RegistrationBlockedReason.nullable(),
});
export type OpenSessionRow = z.infer<typeof OpenSessionRow>;

/** `GET /me/sessions/open`. */
export const OpenSessionsResponse = z.strictObject({
  sessions: z.array(OpenSessionRow),
  hasMore: z.boolean(),
  /** The caller's OVERDUE payments across every team (the registration debt block applies from 3). */
  overdueCount: count,
});
export type OpenSessionsResponse = z.infer<typeof OpenSessionsResponse>;

/** The payment of a billed registration: the inputs of the payment tag, the total and the payment link. */
export const DashboardRegistrationPayment = z.strictObject({
  id: z.uuid(),
  amount: moneyStringSchema,
  status: z.enum(PaymentStatus),
  billingType: z.enum(BillingType),
  dueDate: isoInstant,
  paidAt: isoInstant.nullable(),
  onHold: z.boolean(),
  payoutBlocked: z.boolean(),
});

export const DashboardRegistrationRow = z.strictObject({
  registrationId: z.uuid(),
  sessionId: z.uuid(),
  teamId: z.uuid(),
  teamName: z.string(),
  location: z.string(),
  address: z.string(),
  startsAt: isoInstant,
  endsAt: isoInstant.nullable(),
  sessionStatus: z.enum(SessionStatus),
  status: z.enum(RegistrationStatus),
  waitlistRank: z.number().int().min(1).nullable(),
  guestCount: count,
  /** WITHDRAWN only: the late fee is owed (a free early withdrawal is never listed). */
  withdrawalFeeDue: z.boolean(),
  /** The party fee estimate while there is no payment yet; null once billed or when the session is not priced. */
  estimatedTotal: nullableMoney,
  /** Null until billing has produced a payment (a game is billed after it ends). */
  payment: DashboardRegistrationPayment.nullable(),
});
export type DashboardRegistrationRow = z.infer<typeof DashboardRegistrationRow>;

/** `GET /me/registrations?cursor=`: `cursor` pages `past`; `upcoming` is sent on the first page only. */
export const DashboardRegistrationsQuery = z.strictObject({
  cursor: z.string().min(1).max(512).optional(),
});
export type DashboardRegistrationsQuery = z.infer<typeof DashboardRegistrationsQuery>;

export const DashboardRegistrationsResponse = z.strictObject({
  upcoming: z.array(DashboardRegistrationRow),
  past: z.array(DashboardRegistrationRow),
  nextCursor: z.string().nullable(),
});
export type DashboardRegistrationsResponse = z.infer<typeof DashboardRegistrationsResponse>;

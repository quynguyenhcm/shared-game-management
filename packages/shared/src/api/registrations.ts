/**
 * Request and response contracts for the registration routes, shared by the Fastify routes and the web api-client
 * (registration-and-waitlist AC-VERIFY-7). Requests are strict, so a client can never set what the server owns
 * (`status`, `queuePosition`, `userId`, `teamId`). Validation messages never echo input and are keyed by field
 * (`guests.{i}.sex`, `guests.{i}.skillLevel`, `guests.{i}.displayName`); the web adds the guest number to its copy.
 * Money crosses the wire as a 2-dp `MoneyString`, instants as ISO-8601 strings. Guest names are returned only to
 * the registrant themself, never in list or roster responses.
 */
import { z } from 'zod';
import { moneyStringSchema } from '../money/zod.ts';
import {
  RegistrationSource,
  RegistrationStatus,
  PricingType,
  SessionStatus,
  SkillTier,
  UserSex,
  WithdrawalKind,
} from '../types/enums.ts';

export const MAX_GUESTS = 2;
export const GUEST_NAME_MAX_LENGTH = 100;
/** The upcoming-sessions read model lists this many sessions (R8). */
export const UPCOMING_SESSIONS_LIMIT = 10;

export const REGISTRATION_FIELD_MESSAGES = {
  sexRequired: 'Choose a sex.',
  skillLevelRequired: 'Choose a skill level.',
  nameTooLong: 'Use 100 characters or fewer.',
  tooManyGuests: 'You can bring up to 2 guests.',
  guestsRequired: 'Say who is coming.',
  expectLateRequired: 'Confirm whether the withdrawal is late.',
} as const;

const M = REGISTRATION_FIELD_MESSAGES;

const isoInstant = z.iso.datetime();
const count = z.number().int().min(0);

/** Why the allocator or a registration route refused (a returned refusal, never a throw, on the batch paths). */
export const AllocationRefusalReason = z.enum([
  'overdue_payments',
  'session_not_open',
  'already_registered',
  'party_exceeds_capacity',
  'not_registered',
  'forbidden',
  'late_withdrawal_fee_due',
  'cancellation_terms_changed',
  'auto_enroll_changed',
  'not_found',
]);
export type AllocationRefusalReason = z.infer<typeof AllocationRefusalReason>;

/** The refusals that can leave `canRegister` false on the read model (the rest are route errors, not a blocked state). */
export const RegistrationBlockedReason = AllocationRefusalReason.extract([
  'overdue_payments',
  'session_not_open',
  'party_exceeds_capacity',
  'already_registered',
  'late_withdrawal_fee_due',
]);
export type RegistrationBlockedReason = z.infer<typeof RegistrationBlockedReason>;

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

export const RegistrationGuestInput = z.strictObject({
  sex: z.enum(UserSex, { error: M.sexRequired }),
  skillLevel: z.enum(SkillTier, { error: M.skillLevelRequired }),
  /** Trimmed; an empty name becomes undefined (stored as NULL). */
  displayName: z
    .string()
    .trim()
    .max(GUEST_NAME_MAX_LENGTH, M.nameTooLong)
    .transform((name) => (name === '' ? undefined : name))
    .optional(),
});
export type RegistrationGuestInput = z.infer<typeof RegistrationGuestInput>;

/** `POST /teams/:teamId/sessions/:sessionId/registrations`. */
export const SessionRegisterRequest = z.strictObject({
  guests: z
    .array(RegistrationGuestInput, { error: M.guestsRequired })
    .max(MAX_GUESTS, M.tooManyGuests),
});
export type SessionRegisterRequest = z.infer<typeof SessionRegisterRequest>;

/** `POST .../registrations/me/withdraw`: the caller's view of the terms (R9); the API re-classifies in its transaction. */
export const SessionWithdrawRequest = z.strictObject({
  expectLate: z.boolean({ error: M.expectLateRequired }),
});
export type SessionWithdrawRequest = z.infer<typeof SessionWithdrawRequest>;

// ---------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------

export const RegistrationGuestResponse = z.object({
  position: z.number().int().min(1),
  sex: z.enum(UserSex),
  skillLevel: z.enum(SkillTier),
  displayName: z.string().nullable(),
});

export const MyRegistration = z.object({
  id: z.uuid(),
  status: z.enum(RegistrationStatus),
  guestCount: count,
  guests: z.array(RegistrationGuestResponse),
  /** `1 + count(WAITLISTED rows with a lower queue_position)`, never the raw `queue_position`; null unless WAITLISTED. */
  waitlistRank: z.number().int().min(1).nullable(),
  registeredAt: isoInstant,
  promotedAt: isoInstant.nullable(),
  withdrawnAt: isoInstant.nullable(),
  withdrawalKind: z.enum(WithdrawalKind).nullable(),
  withdrawalFeeDue: z.boolean(),
  /** `AUTO_ENROL` drives the "Added automatically (Auto Enroll)" label (R17). */
  source: z.enum(RegistrationSource),
  /** The pricing snapshot level (R15); null on a row that has never been CONFIRMED. */
  registrantSkillLevel: z.enum(SkillTier).nullable(),
});
export type MyRegistration = z.infer<typeof MyRegistration>;

const nullableMoney = moneyStringSchema.nullable();

export const RegistrationSessionFees = z.object({
  flat: nullableMoney,
  male: nullableMoney,
  female: nullableMoney,
  other: nullableMoney,
  beginner: nullableMoney,
  intermediate: nullableMoney,
  advanced: nullableMoney,
});

export const RegistrationSessionSummary = z.object({
  id: z.uuid(),
  teamId: z.uuid(),
  location: z.string(),
  address: z.string(),
  startsAt: isoInstant,
  endsAt: isoInstant.nullable(),
  cancellationDeadline: isoInstant.nullable(),
  status: z.enum(SessionStatus),
  publicCapacity: count,
  seatsTaken: count,
  seatsLeft: count,
  waitlistLength: count,
  pricingStructure: z.enum(PricingType),
  fees: RegistrationSessionFees,
});

/** `GET /teams/:teamId/sessions/:sessionId/registration`. */
export const RegistrationReadResponse = z.object({
  session: RegistrationSessionSummary,
  me: z.object({
    registration: MyRegistration.nullable(),
    unitFee: nullableMoney,
    estimatedTotal: nullableMoney,
    /** The skill tier the fee is priced at (R15); null unless the session is BY_SKILL_LEVEL or the caller's level is unknown. */
    feeLevel: z.enum(SkillTier).nullable(),
    overdueCount: count,
  }),
  canRegister: z.boolean(),
  blockedReason: RegistrationBlockedReason.nullable(),
});
export type RegistrationReadResponse = z.infer<typeof RegistrationReadResponse>;

/** `POST .../registrations`: 201, `status` is CONFIRMED or WAITLISTED. */
export const SessionRegisterResponse = z.object({
  registration: MyRegistration.extend({ status: z.enum(['CONFIRMED', 'WAITLISTED']) }),
});
export type SessionRegisterResponse = z.infer<typeof SessionRegisterResponse>;

/** `POST .../registrations/me/withdraw`: 200. `replacedBy` never names the promoted player. */
export const SessionWithdrawResponse = z.object({
  registration: z.object({
    status: z.literal('WITHDRAWN'),
    withdrawalKind: z.enum(WithdrawalKind),
    withdrawalFeeDue: z.boolean(),
  }),
  replacedBy: z.enum(['waitlist', 'nobody']),
  feeEstimate: moneyStringSchema,
});
export type SessionWithdrawResponse = z.infer<typeof SessionWithdrawResponse>;

export const UpcomingSessionRow = z.object({
  id: z.uuid(),
  startsAt: isoInstant,
  endsAt: isoInstant.nullable(),
  location: z.string(),
  publicCapacity: count,
  seatsLeft: count,
  waitlistLength: count,
  me: z
    .object({
      status: z.enum(['CONFIRMED', 'WAITLISTED']),
      waitlistRank: z.number().int().min(1).nullable(),
    })
    .nullable(),
});

/** `GET /teams/:teamId/sessions/upcoming`: the next 10 PUBLISHED sessions that have not started (R8). */
export const UpcomingSessionsResponse = z.object({
  sessions: z.array(UpcomingSessionRow),
  hasMore: z.boolean(),
});
export type UpcomingSessionsResponse = z.infer<typeof UpcomingSessionsResponse>;

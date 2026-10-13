/**
 * Compile-time enum parity (AC-INTEGRATION-2, architecture Q12 guard 2): `pnpm run typecheck` fails
 * if the kysely-codegen enum unions and the hand-written `@sgm/shared` enums ever diverge.
 * Runtime parity against pg_enum lives in test/integration/enum-parity.int.test.ts.
 */
import type * as Shared from '@sgm/shared';
import type * as Generated from './types.generated.ts';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

export type EnumParity = [
  Assert<Equal<Generated.UserSex, Shared.UserSex>>,
  Assert<Equal<Generated.SkillTier, Shared.SkillTier>>,
  Assert<Equal<Generated.GlobalRole, Shared.GlobalRole>>,
  Assert<Equal<Generated.TeamVisibility, Shared.TeamVisibility>>,
  Assert<Equal<Generated.TeamRole, Shared.TeamRole>>,
  Assert<Equal<Generated.MembershipStatus, Shared.MembershipStatus>>,
  Assert<Equal<Generated.PricingType, Shared.PricingType>>,
  Assert<Equal<Generated.SessionStatus, Shared.SessionStatus>>,
  Assert<Equal<Generated.RegistrationStatus, Shared.RegistrationStatus>>,
  Assert<Equal<Generated.PaymentStatus, Shared.PaymentStatus>>,
  Assert<Equal<Generated.BillingType, Shared.BillingType>>,
  Assert<Equal<Generated.RecurrenceFrequency, Shared.RecurrenceFrequency>>,
  Assert<Equal<Generated.CreditTransactionType, Shared.CreditTransactionType>>,
  Assert<Equal<Generated.AuthProvider, Shared.AuthProvider>>,
  Assert<Equal<Generated.FeeBasis, Shared.FeeBasis>>,
];

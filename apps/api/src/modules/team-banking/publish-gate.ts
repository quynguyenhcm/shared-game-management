/**
 * The publish gate: a paid session may only be PUBLISHED for a team with a usable payout destination
 * (team-banking-and-gst Phase 3; decisions: banking architecture Q4 and the task file's reconciliation R3, R4;
 * contract text: ADR 0016). This file is the module's public surface for session-scheduling-engine and
 * wallet-and-akahu-billing: other modules import it, never `repo.ts` or `service.ts`.
 *
 * Contract: call `assertTeamCanPublishPaidSession` (or the non-throwing `checkTeamCanPublishPaidSession`) INSIDE
 * the transaction that publishes a session, inserts one as PUBLISHED, or raises a published session's fee from
 * free to paid, BEFORE that transaction takes any `game_sessions` lock. It takes `teams FOR KEY SHARE` until
 * COMMIT, which serialises against a banking removal (`FOR UPDATE`) without making publishes wait on moderation
 * or banking saves (`FOR NO KEY UPDATE`). The database trigger `game_sessions_paid_requires_payout` is the
 * backstop for code that skips the gate; it is not for flow control.
 */
import type { FastifyBaseLogger } from 'fastify';
import { MoneyValidationError, ZERO, parseMoney, toCents, type PricingType } from '@sgm/shared';
import type { Database } from '../../lib/db/kysely.ts';
import { AppError } from '../../lib/http/errors.ts';

export { mapBankingDbError, mapPublishGateDbError } from './errors.ts';

/** The `game_sessions` fee columns, camelCased. */
export type FeeKey =
  | 'feeFlat'
  | 'feeMale'
  | 'feeFemale'
  | 'feeOther'
  | 'feeBeginner'
  | 'feeIntermediate'
  | 'feeAdvanced';

/** The fee columns as the 2-dp money strings the database returns; `null` is an unset column. */
export type PublishGateFees = { readonly [K in FeeKey]: string | null };

/**
 * Which fee columns apply to which pricing structure. A `Record` over `PricingType`, so adding a structure to
 * the enum is a compile error here until its columns are listed. Twin of `game_session_is_paid` (migration D-49).
 */
const APPLIES: Readonly<Record<PricingType, readonly FeeKey[]>> = {
  FLAT: ['feeFlat'],
  BY_SEX: ['feeMale', 'feeFemale', 'feeOther'],
  BY_SKILL_LEVEL: ['feeBeginner', 'feeIntermediate', 'feeAdvanced'],
};

/** True when one fee value is above zero. NULL counts as 0; a value that is not valid money fails closed (paid). */
function isPositiveFee(value: string | null): boolean {
  if (value === null) return false;
  try {
    return toCents(parseMoney(value)) > toCents(ZERO);
  } catch (error) {
    if (error instanceof MoneyValidationError) return true;
    throw error;
  }
}

/**
 * Paid means: some fee column that applies to the pricing structure is above zero. NULL counts as 0, a negative
 * fee is not paid, columns of another structure never count. An unknown structure fails closed (paid), like the
 * SQL function. The parity fixture (`test/fixtures/paid-session-matrix.ts`) holds both to the same answers.
 */
export function isPaidSession(pricingStructure: PricingType, fees: PublishGateFees): boolean {
  // Own keys only, so a string such as 'constructor' fails closed instead of reaching the prototype.
  if (!Object.hasOwn(APPLIES, pricingStructure)) return true;
  const applicable = APPLIES[pricingStructure];
  return applicable.some((key) => isPositiveFee(fees[key]));
}

/** The subset of the request (or job) logger the gate uses. */
export type PublishGateLogger = Pick<FastifyBaseLogger, 'info'>;

export interface PublishGateInput {
  readonly teamId: string;
  readonly pricingStructure: PricingType;
  readonly fees: PublishGateFees;
  /** Logs `team.banking.publish_gate_refused` on a refusal; omit to stay silent. */
  readonly log?: PublishGateLogger;
  /** Added to the refusal log line only when the caller has one (a job may not). */
  readonly actorId?: string;
}

/** Why a paid publish was refused. Logged; the API error is the same `payout_not_configured` for all three. */
export type PublishGateRefusalReason = 'not_configured' | 'payout_blocked' | 'team_not_found';

export type PublishGateResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: PublishGateRefusalReason };

/**
 * Non-throwing gate for callers that handle a refusal themselves (the recurrence materialiser saves the refused
 * instance as DRAFT). A free session returns ok without a query or a lock. A paid one locks the team row
 * `FOR KEY SHARE` and reads the generated `is_payout_configured` (block complete AND `payout_blocked_at IS NULL`)
 * in that one statement, so the value is the version committed after any removal that was in front of us.
 */
export async function checkTeamCanPublishPaidSession(
  trx: Database,
  input: PublishGateInput,
): Promise<PublishGateResult> {
  if (!trx.isTransaction) {
    throw new Error('the publish gate must run inside the publishing transaction');
  }
  if (!isPaidSession(input.pricingStructure, input.fees)) return { ok: true };

  const row = await trx
    .selectFrom('teams')
    .select(['is_payout_configured', 'payout_blocked_at'])
    .where('id', '=', input.teamId)
    .forKeyShare()
    .executeTakeFirst();

  if (row?.is_payout_configured === true) return { ok: true };
  const reason: PublishGateRefusalReason =
    row === undefined
      ? 'team_not_found'
      : row.payout_blocked_at === null
        ? 'not_configured'
        : 'payout_blocked';
  // Ids and the reason only: never a bank value.
  input.log?.info(
    {
      event: 'team.banking.publish_gate_refused',
      teamId: input.teamId,
      reason,
      errorCode: 'payout_not_configured',
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
    },
    'paid session publish refused: no usable payout details',
  );
  return { ok: false, reason };
}

/** As `checkTeamCanPublishPaidSession`, but throws `AppError('payout_not_configured')` (409) on a refusal. */
export async function assertTeamCanPublishPaidSession(
  trx: Database,
  input: PublishGateInput,
): Promise<void> {
  const result = await checkTeamCanPublishPaidSession(trx, input);
  if (!result.ok) throw new AppError('payout_not_configured');
}

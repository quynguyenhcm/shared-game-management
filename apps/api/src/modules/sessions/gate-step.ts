/**
 * The publish gate as a step of an admin write (ADR 0016 gate contract points 1-3): called after `teams FOR KEY SHARE` and
 * before any `game_sessions` lock, by every write that could make a PUBLISHED session paid (a one-off edit, a series edit that
 * propagates to published instances). A refusal is logged with its reason and surfaces as 409 `payout_not_configured`, with
 * nothing saved.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../../lib/db/kysely.ts';
import { AppError } from '../../lib/http/errors.ts';
import {
  checkTeamCanPublishPaidSession,
  type PublishGateFees,
} from '../team-banking/publish-gate.ts';
import type { FeeColumns } from './content.ts';
import type { SessionRow } from './view.ts';

export interface GateStepInput {
  readonly teamId: string;
  /** The subject of the write, for the log line: `{ sessionId }` or `{ ruleId }`. */
  readonly subject: { readonly sessionId: string } | { readonly ruleId: string };
  readonly actorId: string;
  readonly fees: FeeColumns | PublishGateFees;
  readonly pricingStructure: SessionRow['pricing_structure'];
  readonly path: 'manual' | 'edit' | 'series_edit';
  readonly log: Pick<FastifyBaseLogger, 'info'>;
}

export async function gateOrRefuse(trx: Database, input: GateStepInput): Promise<void> {
  const result = await checkTeamCanPublishPaidSession(trx, {
    teamId: input.teamId,
    pricingStructure: input.pricingStructure,
    fees: input.fees,
    log: input.log,
    actorId: input.actorId,
  });
  if (result.ok) return;
  input.log.info(
    {
      event: 'session.publish_refused',
      teamId: input.teamId,
      ...input.subject,
      actorId: input.actorId,
      path: input.path,
      reason: result.reason,
      errorCode: 'payout_not_configured',
    },
    'session publish refused: no usable payout details',
  );
  throw new AppError('payout_not_configured');
}

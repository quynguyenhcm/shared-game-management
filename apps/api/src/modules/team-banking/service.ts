/**
 * Team banking and GST use cases (team-banking-and-gst Phase 2). Decisions: the task file's Creative Reconciliation
 * (R1 the payout destination is the account name and number only; R2 one GST number; R3 a save clears
 * `payout_blocked_at`; R4 the lock protocol; R7 unreadable details; R8 audit columns and the change email) and the
 * banking architecture doc.
 *
 * Every write is one transaction that locks the team row first and re-checks under that lock that the actor is still
 * an approved admin (the route guard ran outside it): saves hold `FOR NO KEY UPDATE` (the moderation mutex), a
 * removal holds `FOR UPDATE` as its first statement and only reads afterwards. Secrets: the account name and number
 * are sealed with `FieldCrypto` under their column AAD; neither the number nor the name is ever logged, put in an
 * error or put in a job (the change email carries only who, when and which fields).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import {
  BANKING_FIELD_MESSAGES,
  deriveBankAccountLast4,
  type BankingResponse,
  type GstResponse,
  type PutBankingRequest,
  type PutGstRequest,
  type RemoveBankingResponse,
} from '@sgm/shared';
import { enqueueEmail } from '../../jobs/send-email.ts';
import { refusing } from '../../lib/auth/team-refusals.ts';
import type { Clock } from '../../lib/clock.ts';
import { DecryptionError, type FieldCrypto } from '../../lib/crypto/crypto.ts';
import type { Database } from '../../lib/db/kysely.ts';
import { AppError } from '../../lib/http/errors.ts';
import type { JobRunner } from '../../lib/jobs/jobs.ts';
import { assertTeamAdminUnderLock } from '../teams/admin-lock.ts';
import { buildBankingChangedEmail, type BankingChangedField } from './emails.ts';
import { mapBankingDbError } from './errors.ts';
import * as repo from './repo.ts';

/** The subset of the request logger the service uses (`request.log`, which carries the trace ids). */
export type TeamBankingLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

export interface TeamBankingContext {
  readonly log: TeamBankingLogger;
}

export interface TeamBankingServiceDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly crypto: FieldCrypto;
  /** Job producer: the change email is enqueued through it inside the change's own transaction. */
  readonly jobs: Pick<JobRunner, 'enqueue'>;
  /** `config.auth.webBaseUrl`: origin of the web app for the link in the email, no trailing slash. */
  readonly webBaseUrl: string;
}

export interface TeamBankingService {
  getBanking(teamId: string, ctx: TeamBankingContext): Promise<BankingResponse>;
  putBanking(
    teamId: string,
    actorId: string,
    input: PutBankingRequest,
    ctx: TeamBankingContext,
  ): Promise<BankingResponse>;
  removeBanking(
    teamId: string,
    actorId: string,
    ctx: TeamBankingContext,
  ): Promise<RemoveBankingResponse>;
  getGst(teamId: string): Promise<GstResponse>;
  putGst(
    teamId: string,
    actorId: string,
    input: PutGstRequest,
    ctx: TeamBankingContext,
  ): Promise<GstResponse>;
}

type Column = 'bank_account_name' | 'bank_account_number';

/** A stored envelope after opening: nothing stored, the plaintext, or unreadable (key gone, bytes corrupted). */
type Opened =
  | { readonly kind: 'empty' }
  | { readonly kind: 'ok'; readonly value: string }
  | { readonly kind: 'unreadable' };

export function createTeamBankingService(deps: TeamBankingServiceDeps): TeamBankingService {
  const { db, clock, crypto, jobs, webBaseUrl } = deps;

  const sealContext = (teamId: string, column: Column) => ({
    table: 'teams',
    column,
    rowId: teamId,
  });

  /** Opens one envelope. A `DecryptionError` is logged with the team and the reason code only (R7). */
  function open(
    envelope: string | null,
    teamId: string,
    column: Column,
    log: TeamBankingLogger,
  ): Opened {
    if (envelope === null) return { kind: 'empty' };
    try {
      return { kind: 'ok', value: crypto.decrypt(envelope, sealContext(teamId, column)) };
    } catch (error) {
      if (!(error instanceof DecryptionError)) throw error;
      log.error(
        { event: 'team.banking.decrypt_failed', teamId, column, reason: error.reason },
        'team banking details could not be decrypted',
      );
      return { kind: 'unreadable' };
    }
  }

  /**
   * The masked view an admin may read: the full name, the last 4, never the number or an envelope. `opened`
   * passes envelopes the caller already opened for this same row, so a damaged one is decrypted (and logged) once.
   */
  function present(
    row: repo.BankingRow,
    teamId: string,
    log: TeamBankingLogger,
    opened?: { readonly name: Opened; readonly number: Opened },
  ): BankingResponse {
    const name = opened?.name ?? open(row.accountNameEnvelope, teamId, 'bank_account_name', log);
    // The number is opened only to detect a damaged block (AES-GCM proves integrity only by decrypting); its
    // plaintext is dropped at once and never leaves this function.
    const number =
      opened?.number ?? open(row.accountNumberEnvelope, teamId, 'bank_account_number', log);
    return {
      banking: {
        isPayoutConfigured: row.isPayoutConfigured,
        payoutBlocked: row.payoutBlockedAt !== null,
        accountName: name.kind === 'ok' ? name.value : null,
        unreadable: name.kind === 'unreadable' || number.kind === 'unreadable',
        accountNumberLast4: row.last4,
        lastChanged:
          row.updatedAt === null
            ? null
            : {
                at: row.updatedAt.toISOString(),
                by: row.updatedByName === null ? null : { fullName: row.updatedByName },
              },
      },
    };
  }

  /** One sealed `send-email` job per approved admin, the actor included, in the change's own transaction (P5). */
  async function notifyAdmins(
    trx: Database,
    input: {
      teamId: string;
      teamName: string;
      actorId: string;
      kind: 'saved' | 'removed';
      changedFields: readonly BankingChangedField[];
      changeKey: string;
      when: Date;
    },
  ): Promise<void> {
    const recipients = await repo.listApprovedAdmins(trx, input.teamId);
    const actorName = await repo.getUserName(trx, input.actorId);
    for (const recipient of recipients) {
      await enqueueEmail(
        jobs,
        buildBankingChangedEmail({
          to: recipient.email,
          recipientName: recipient.fullName,
          recipientId: recipient.userId,
          teamName: input.teamName,
          teamId: input.teamId,
          actorName,
          kind: input.kind,
          changedFields: input.changedFields,
          when: input.when,
          webBaseUrl,
          changeKey: input.changeKey,
        }),
        // Sealed: the job row holds the recipient address and names and is retained for days.
        { trx, crypto },
      );
    }
  }

  const requireRow = async (reader: Database, teamId: string): Promise<repo.BankingRow> => {
    const row = await repo.readBanking(reader, teamId);
    // The guard proved the team exists; a vanished row is the same answer as any other missing team.
    if (row === undefined) throw new AppError('forbidden');
    return row;
  };

  return {
    async getBanking(teamId, ctx) {
      return present(await requireRow(db, teamId), teamId, ctx.log);
    },

    putBanking(teamId, actorId, input, ctx) {
      return refusing(ctx.log, { action: 'put_banking', actorId, teamId }, async () => {
        const now = clock.now();
        let result: {
          row: repo.BankingRow;
          written: { firstSetup: boolean; changedFields: BankingChangedField[] } | null;
          /** Set when the returned row is the one already opened here (nothing was written). */
          opened?: { name: Opened; number: Opened };
        };
        try {
          result = await db.transaction().execute(async (trx) => {
            await assertTeamAdminUnderLock(trx, teamId, actorId, 'noKeyUpdate');
            const stored = await requireRow(trx, teamId);
            // A replay of a request that already committed (D-54): current state, no write, no email, even when
            // another admin has saved something else since.
            if (stored.changeKeys.includes(input.changeKey)) {
              return { row: stored, written: null };
            }
            const given = input.accountNumber;
            const storedName = open(
              stored.accountNameEnvelope,
              teamId,
              'bank_account_name',
              ctx.log,
            );
            const storedNumber = open(
              stored.accountNumberEnvelope,
              teamId,
              'bank_account_number',
              ctx.log,
            );
            // No number to keep: none is stored, or the stored one is unreadable (R7), so only a full save
            // can replace the block. The name is always in the request, so an unreadable name needs nothing.
            if (given === undefined && storedNumber.kind !== 'ok') {
              throw new AppError('validation_failed', {
                fieldErrors: { accountNumber: [BANKING_FIELD_MESSAGES.accountNumberRequired] },
              });
            }
            const changedFields: BankingChangedField[] = [];
            if (storedName.kind !== 'ok' || storedName.value !== input.accountName) {
              changedFields.push('accountName');
            }
            if (
              given !== undefined &&
              (storedNumber.kind !== 'ok' || storedNumber.value !== given)
            ) {
              changedFields.push('accountNumber');
            }
            // A save that changes nothing sends nothing and leaves the settings and the audit stamp alone, unless
            // it lifts a payout block. Its key is still claimed, so a late replay of it is recognised (D-54).
            if (changedFields.length === 0 && stored.payoutBlockedAt === null) {
              await repo.claimChangeKey(trx, teamId, input.changeKey);
              return {
                row: stored,
                written: null,
                opened: { name: storedName, number: storedNumber },
              };
            }
            await repo.writeBanking(trx, teamId, {
              accountNameEnvelope: crypto.encrypt(
                input.accountName,
                sealContext(teamId, 'bank_account_name'),
              ),
              ...(given === undefined
                ? {}
                : {
                    number: {
                      envelope: crypto.encrypt(given, sealContext(teamId, 'bank_account_number')),
                      last4: deriveBankAccountLast4(given),
                    },
                  }),
              now,
              actorId,
              changeKey: input.changeKey,
            });
            await notifyAdmins(trx, {
              teamId,
              teamName: stored.teamName,
              actorId,
              kind: 'saved',
              changedFields,
              changeKey: input.changeKey,
              when: now,
            });
            return {
              row: await requireRow(trx, teamId),
              written: { firstSetup: stored.accountNumberEnvelope === null, changedFields },
            };
          });
        } catch (error) {
          throw mapBankingDbError(error);
        }
        if (result.written !== null) {
          // Ids, flags and field names only: never a value.
          ctx.log.info(
            {
              event: 'team.banking.updated',
              teamId,
              actorId,
              firstSetup: result.written.firstSetup,
              changedFields: result.written.changedFields,
            },
            'team banking updated',
          );
        }
        return present(result.row, teamId, ctx.log, result.opened);
      });
    },

    removeBanking(teamId, actorId, ctx) {
      return refusing(ctx.log, { action: 'remove_banking', actorId, teamId }, async () => {
        const now = clock.now();
        let result: { row: repo.BankingRow; removed: boolean };
        try {
          result = await db.transaction().execute(async (trx) => {
            // FOR UPDATE is the first statement; afterwards this transaction only reads session and payment rows.
            await assertTeamAdminUnderLock(trx, teamId, actorId, 'update');
            const stored = await requireRow(trx, teamId);
            const hadBlock = stored.accountNumberEnvelope !== null;
            if (!hadBlock && stored.payoutBlockedAt === null)
              return { row: stored, removed: false };
            if (hadBlock && (await repo.isBankingInUse(trx, teamId))) {
              throw new AppError('banking_in_use');
            }
            // A removal has no form to carry a key; its server key is stored so no earlier save replays over it.
            const changeKey = randomUUID();
            await repo.clearBanking(trx, teamId, { now, actorId, changeKey });
            if (hadBlock) {
              await notifyAdmins(trx, {
                teamId,
                teamName: stored.teamName,
                actorId,
                kind: 'removed',
                changedFields: [],
                changeKey,
                when: now,
              });
            }
            return { row: await requireRow(trx, teamId), removed: hadBlock };
          });
        } catch (error) {
          throw mapBankingDbError(error);
        }
        if (result.removed) {
          ctx.log.info({ event: 'team.banking.removed', teamId, actorId }, 'team banking removed');
        }
        // `removed` false: nothing was saved, nobody was emailed (the web picks a neutral notice).
        return { ...present(result.row, teamId, ctx.log), removed: result.removed };
      });
    },

    async getGst(teamId) {
      const row = await repo.readGst(db, teamId);
      if (row === undefined) throw new AppError('forbidden');
      return { gst: { gstRegistered: row.gstRegistered, gstNumber: row.gstNumber } };
    },

    putGst(teamId, actorId, input, ctx) {
      return refusing(ctx.log, { action: 'put_gst', actorId, teamId }, async () => {
        const result = await db.transaction().execute(async (trx) => {
          await assertTeamAdminUnderLock(trx, teamId, actorId, 'noKeyUpdate');
          const stored = await repo.readGst(trx, teamId);
          if (stored === undefined) throw new AppError('forbidden');
          const current = { gstRegistered: stored.gstRegistered, gstNumber: stored.gstNumber };
          // A replay of a request that already committed (D-54): current state, no write, no log.
          if (stored.changeKeys.includes(input.changeKey)) return { gst: current, written: false };
          // Omitted keeps the saved number (turning GST off sends none, so it survives); null removes it.
          const gstNumber = input.gstNumber === undefined ? stored.gstNumber : input.gstNumber;
          if (input.gstRegistered && gstNumber === null) {
            throw new AppError('validation_failed', {
              fieldErrors: { gstNumber: [BANKING_FIELD_MESSAGES.gstNumberRequired] },
            });
          }
          const next = { gstRegistered: input.gstRegistered, gstNumber };
          if (
            next.gstRegistered === current.gstRegistered &&
            next.gstNumber === current.gstNumber
          ) {
            // Nothing changes, but the request is applied: claim its key so a late replay is recognised.
            await repo.claimChangeKey(trx, teamId, input.changeKey);
            return { gst: current, written: false };
          }
          await repo.writeGst(trx, teamId, { ...next, changeKey: input.changeKey });
          return { gst: next, written: true };
        });
        if (result.written) {
          ctx.log.info(
            { event: 'team.gst.updated', teamId, actorId, gstRegistered: result.gst.gstRegistered },
            'team gst updated',
          );
        }
        return { gst: result.gst };
      });
    },
  };
}

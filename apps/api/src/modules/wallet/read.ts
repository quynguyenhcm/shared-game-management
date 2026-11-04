/**
 * The wallet read model, `GET /teams/:teamId/wallet` (wallet-and-akahu-billing Phase 4a; CR-17, AC-HAPPY-12, CR-3 return page).
 * Plain reads, scoped to the caller's own wallet in the team; nothing is locked and nothing is written:
 *
 *   - balance (no wallet row reads 0.00; a read never creates one), the cap, the headroom and the low-credit threshold;
 *   - the open top-up (CREATING, OPEN or HELD) with its outcome, and the last finished top-up when it was not credited (B3 notice);
 *   - one page of the ledger, newest first, each deduction with its session (location, start).
 *
 * The one side effect is a SIGNAL, never an apply (CR-3): when Akahu's return lands on `?topUp=<id>` and that top-up is OPEN, one
 * `akahu-sync` re-read is requested, at most once per `SYNC_THROTTLE_MS` of the intent's last real read.
 */
import { sql } from 'kysely';
import {
  LOW_CREDIT_THRESHOLD,
  WALLET_CAP,
  intentOutcome,
  parseMoney,
  subtract,
  toMoneyString,
  type WalletQuery,
  type WalletResponse,
} from '@sgm/shared';
import { SYNC_THROTTLE_MS } from '../../lib/akahu/constants.ts';
import type { Clock } from '../../lib/clock.ts';
import type { Database } from '../../lib/db/kysely.ts';
import {
  KEYSET_TIME_FORMAT,
  decodeKeysetCursor,
  encodeKeysetCursor,
} from '../../lib/http/cursor.ts';
import { findBlockingTopUp, findLatestFinishedTopUp, type WalletOwner } from './top-up-repo.ts';
import type { WalletLogger } from './top-up.ts';

/** Ledger rows per page. */
export const WALLET_LEDGER_PAGE_SIZE = 50;

export interface WalletReadDeps {
  readonly db: Database;
  readonly clock: Clock;
  /** Enqueues one `akahu-sync` re-read (injected by the app; the wallet module never imports billing). */
  readonly requestSync: (input: {
    readonly akahuPaymentId: string;
    readonly source: 'return_page';
  }) => Promise<unknown>;
}

export async function readWallet(
  deps: WalletReadDeps,
  owner: WalletOwner,
  query: WalletQuery,
  log: WalletLogger,
): Promise<WalletResponse> {
  const after = query.cursor === undefined ? undefined : decodeKeysetCursor(query.cursor);
  const wallet = await deps.db
    .selectFrom('player_credits')
    .select('balance')
    .where('user_id', '=', owner.userId)
    .where('team_id', '=', owner.teamId)
    .executeTakeFirst();
  const balance = parseMoney(wallet?.balance ?? '0.00');
  const pending = await findBlockingTopUp(deps.db, owner);
  const finished = await findLatestFinishedTopUp(deps.db, owner);

  let ledger = deps.db
    .selectFrom('credit_transactions as c')
    .leftJoin('registrations as r', 'r.id', 'c.registration_id')
    .leftJoin('game_sessions as s', 's.id', 'r.session_id')
    .select([
      'c.id',
      'c.transaction_type',
      'c.amount',
      'c.resulting_balance',
      'c.created_at',
      's.id as session_id',
      's.location',
      's.starts_at',
      sql<string>`to_char(c.created_at AT TIME ZONE 'UTC', ${KEYSET_TIME_FORMAT})`.as('at_cursor'),
    ])
    .where('c.user_id', '=', owner.userId)
    .where('c.team_id', '=', owner.teamId);
  if (after !== undefined) {
    ledger = ledger.where(
      sql<boolean>`(c.created_at, c.id) < (${after.at}::timestamptz, ${after.id}::uuid)`,
    );
  }
  const rows = await ledger
    .orderBy('c.created_at', 'desc')
    .orderBy('c.id', 'desc')
    .limit(WALLET_LEDGER_PAGE_SIZE + 1)
    .execute();
  const page = rows.slice(0, WALLET_LEDGER_PAGE_SIZE);
  const last = page.at(-1);

  if (
    query.topUp !== undefined &&
    pending !== undefined &&
    pending.id === query.topUp &&
    pending.status === 'OPEN' &&
    pending.akahuPaymentId !== null
  ) {
    const now = deps.clock.now();
    const stale =
      pending.lastSyncedAt === null ||
      now.getTime() - pending.lastSyncedAt.getTime() >= SYNC_THROTTLE_MS;
    if (stale) {
      try {
        await deps.requestSync({ akahuPaymentId: pending.akahuPaymentId, source: 'return_page' });
      } catch (error) {
        // A read never fails because the signal could not be queued: the webhook and reconcile still come.
        log.warn(
          {
            event: 'wallet.topup.sync_enqueue_failed',
            topUpId: pending.id,
            errorClass: error instanceof Error ? error.name : typeof error,
          },
          'return-page re-read could not be queued',
        );
      }
    }
  }

  return {
    wallet: {
      balance: toMoneyString(balance),
      cap: toMoneyString(WALLET_CAP),
      headroom: toMoneyString(subtract(WALLET_CAP, balance)),
      lowCreditThreshold: toMoneyString(LOW_CREDIT_THRESHOLD),
      pendingTopUp:
        pending === undefined
          ? null
          : {
              id: pending.id,
              amount: toMoneyString(pending.amount),
              status: pending.status,
              outcome: intentOutcome(pending),
              createdAt: pending.createdAt.toISOString(),
            },
      lastClosedTopUp:
        finished !== undefined && (finished.status === 'UNAPPLIED' || finished.status === 'CLOSED')
          ? {
              id: finished.id,
              amount: toMoneyString(finished.amount),
              status: finished.status,
              unappliedReason: finished.unappliedReason,
              closedAt: (finished.closedAt ?? finished.createdAt).toISOString(),
            }
          : null,
    },
    transactions: page.map((row) => ({
      id: row.id,
      type: row.transaction_type,
      amount: toMoneyString(parseMoney(row.amount)),
      resultingBalance: toMoneyString(parseMoney(row.resulting_balance)),
      createdAt: row.created_at.toISOString(),
      session:
        row.session_id === null || row.location === null || row.starts_at === null
          ? null
          : { id: row.session_id, location: row.location, startsAt: row.starts_at.toISOString() },
    })),
    nextCursor:
      rows.length > WALLET_LEDGER_PAGE_SIZE && last !== undefined
        ? encodeKeysetCursor({ at: last.at_cursor, id: last.id })
        : null,
  };
}

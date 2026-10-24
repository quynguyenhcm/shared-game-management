/**
 * Deterministic "hold this transaction open here" for race tests (no sleeps). A Kysely handle over a wrapping pool that
 *
 * - records every executed statement with the id of the connection that ran it (so a test can check the lock order of each
 *   transaction afterwards), and
 * - can be ARMED with a statement pattern: the first statement that matches is run, then its caller is parked until the test
 *   releases it. Whatever locks that statement took stay held, because the transaction is still open.
 *
 * The production code under test is unchanged: it simply runs through this handle. A test arms the gate, starts the real use case,
 * waits for `reached`, starts the contender, waits for Postgres itself to report the contender blocked (`waitForLockWaiters`),
 * then calls `release`.
 */
import { Kysely, PostgresDialect, type PostgresPool, type PostgresPoolClient } from 'kysely';
import type pg from 'pg';
import type { Database } from '../../src/lib/db/kysely.ts';
import type { DB } from '../../src/lib/db/types.generated.ts';

export interface StatementHold {
  /** Resolves once a statement matching the armed pattern has run (its locks are held). */
  readonly reached: Promise<void>;
  /** Lets the parked statement's caller continue. Idempotent. */
  readonly release: () => void;
}

export interface RecordedStatement {
  /** Which pooled connection ran it (one transaction = one connection from `begin` to `commit`/`rollback`). */
  readonly connection: number;
  /** Parameterised SQL as Kysely compiles it (lower case). */
  readonly sql: string;
}

export interface GatedDatabase {
  readonly db: Database;
  readonly statements: RecordedStatement[];
  /** Parks the next statement matching `pattern`; only one gate is armed at a time. */
  arm(pattern: RegExp): StatementHold;
}

export function createGatedDatabase(pool: pg.Pool): GatedDatabase {
  const statements: RecordedStatement[] = [];
  let nextConnection = 0;
  let armed:
    | { readonly pattern: RegExp; readonly reached: () => void; readonly released: Promise<void> }
    | undefined;

  const gatedPool: PostgresPool = {
    options: pool.options,
    async connect(): Promise<PostgresPoolClient> {
      const client = await pool.connect();
      nextConnection += 1;
      const connection = nextConnection;
      const wrapped = {
        async query(first: unknown, parameters?: readonly unknown[]): Promise<unknown> {
          if (typeof first !== 'string') {
            // A streaming cursor: the sessions code never uses one, pass it through untouched.
            return (client.query as (cursor: unknown) => unknown)(first);
          }
          const result: unknown = await client.query(first, parameters as unknown[]);
          statements.push({ connection, sql: first });
          if (armed?.pattern.test(first) === true) {
            const parked = armed;
            armed = undefined;
            parked.reached();
            await parked.released;
          }
          return result;
        },
        release(): void {
          client.release();
        },
      };
      return wrapped as unknown as PostgresPoolClient;
    },
    // The test database owns the pool; destroying the Kysely handle must not end it.
    end: () => Promise.resolve(),
  };

  return {
    db: new Kysely<DB>({ dialect: new PostgresDialect({ pool: gatedPool }) }),
    statements,
    arm(pattern) {
      let reached!: () => void;
      let release!: () => void;
      const reachedPromise = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      armed = { pattern, reached, released };
      return { reached: reachedPromise, release };
    },
  };
}

/** The statements of each transaction (`begin` .. `commit`/`rollback`), per connection, in execution order. */
export function transactionsOf(statements: readonly RecordedStatement[]): string[][] {
  const open = new Map<number, string[]>();
  const done: string[][] = [];
  for (const { connection, sql } of statements) {
    if (sql === 'begin') {
      open.set(connection, []);
    } else if (sql === 'commit' || sql === 'rollback') {
      const finished = open.get(connection);
      if (finished !== undefined) done.push(finished);
      open.delete(connection);
    } else {
      open.get(connection)?.push(sql);
    }
  }
  done.push(...open.values());
  return done;
}

/** Lock levels of ADR 0016 / ADR 0019 (T-1): a transaction may only acquire row locks at rising levels. */
const LOCK_LEVELS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'teams', pattern: /from "teams".* for (key share|share|no key update|update)$/ },
  {
    name: 'recurring_session_rules',
    pattern: /from "recurring_session_rules".* for (no key update|update)$/,
  },
  { name: 'team_members', pattern: /from "team_members".* for (share|no key update|update)$/ },
  { name: 'game_sessions', pattern: /from "game_sessions".* for (no key update|update)$/ },
];

/**
 * Problems found in the lock order of the recorded transactions: a lock at a lower level taken after a higher one
 * (`teams -> recurring_session_rules -> team_members -> game_sessions`), and `teams FOR UPDATE` / `FOR NO KEY UPDATE` inside any
 * transaction that also locks rules or sessions (teams is only ever `KEY SHARE` there). An empty list means the order held.
 */
export function lockOrderViolations(statements: readonly RecordedStatement[]): string[] {
  const problems: string[] = [];
  for (const transaction of transactionsOf(statements)) {
    let highest = -1;
    let highestName = '';
    const acquired = new Set<number>();
    // Only rule and session locks make a transaction a "sessions transaction" for the teams-strength rule.
    const locksRulesOrSessions = transaction.some(
      (sql) =>
        LOCK_LEVELS[1]?.pattern.test(sql) === true || LOCK_LEVELS[3]?.pattern.test(sql) === true,
    );
    for (const sql of transaction) {
      const level = LOCK_LEVELS.findIndex((candidate) => candidate.pattern.test(sql));
      if (level === -1) continue;
      const name = LOCK_LEVELS[level]?.name ?? '';
      // Taking a lock this transaction already holds again (the gate's KEY SHARE after the prologue's) acquires nothing new.
      if (level < highest && !acquired.has(level)) {
        problems.push(`${name} locked after ${highestName}: ${sql}`);
      }
      if (level === 0 && locksRulesOrSessions && /for (no key update|update)$/.test(sql)) {
        problems.push(`teams taken stronger than KEY SHARE in a sessions transaction: ${sql}`);
      }
      acquired.add(level);
      if (level > highest) {
        highest = level;
        highestName = name;
      }
    }
  }
  return problems;
}

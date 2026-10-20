/**
 * A Kysely `log` hook that records every executed SQL statement, in order (architecture Q7, option 7C). The
 * gate-before-lock proof asserts, per publish path, that the gate's `teams … for key share` statement comes before
 * the first statement that locks or writes `game_sessions`. It sees the real statement order, including locks taken
 * by helpers and by triggers' parent statements.
 */
import { Kysely, type Dialect, type LogEvent } from 'kysely';
import type { DB } from '../../src/lib/db/types.generated.ts';

export interface QueryRecorder {
  /** The `log` option for `new Kysely(...)`. */
  readonly log: (event: LogEvent) => void;
  /** Executed statements (parameterised SQL text, lower case as Kysely compiles it), oldest first. */
  readonly statements: string[];
  /** Index of the first statement matching `pattern`, or -1. */
  indexOf(pattern: RegExp): number;
  /** Throws unless `first` matched a statement and `second` matched only a later one (or never ran). */
  assertBefore(first: RegExp, second: RegExp): void;
  reset(): void;
}

export function createQueryRecorder(): QueryRecorder {
  const statements: string[] = [];
  const indexOf = (pattern: RegExp): number => statements.findIndex((sql) => pattern.test(sql));
  return {
    statements,
    log: (event) => {
      if (event.level === 'query') statements.push(event.query.sql);
    },
    indexOf,
    assertBefore(first, second) {
      const a = indexOf(first);
      if (a === -1)
        throw new Error(`${String(first)} never ran. Statements:\n${statements.join('\n')}`);
      const b = indexOf(second);
      if (b !== -1 && b < a) {
        throw new Error(
          `${String(second)} ran at #${b} before ${String(first)} at #${a}. Statements:\n${statements.join('\n')}`,
        );
      }
    },
    reset() {
      statements.length = 0;
    },
  };
}

/** A Kysely over `dialect` whose every executed statement lands in `recorder`. */
export function createRecordingDatabase(dialect: Dialect, recorder: QueryRecorder): Kysely<DB> {
  return new Kysely<DB>({ dialect, log: recorder.log });
}

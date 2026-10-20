import type { Kysely } from 'kysely';
import { DummyDriver, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { DB } from '../../src/lib/db/types.generated.ts';
import { createQueryRecorder, createRecordingDatabase } from './query-recorder.ts';

function dummyDatabase(recorder: ReturnType<typeof createQueryRecorder>): Kysely<DB> {
  return createRecordingDatabase(
    {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    recorder,
  );
}

describe('query recorder', () => {
  it('records each executed statement in order and finds the first match', async () => {
    const recorder = createQueryRecorder();
    const db = dummyDatabase(recorder);
    await db.selectFrom('teams').select('id').forKeyShare().execute();
    await db.selectFrom('game_sessions').select('id').forUpdate().execute();
    await db.updateTable('game_sessions').set({ location: 'x' }).execute();

    expect(recorder.statements).toHaveLength(3);
    expect(recorder.indexOf(/from "teams".*for key share/)).toBe(0);
    expect(recorder.indexOf(/for update/)).toBe(1);
    expect(recorder.indexOf(/update "game_sessions"/)).toBe(2);
    expect(recorder.indexOf(/nothing like this/)).toBe(-1);
  });

  it('assertBefore passes when the first pattern precedes the second and names the order when it does not', async () => {
    const recorder = createQueryRecorder();
    const db = dummyDatabase(recorder);
    await db.selectFrom('teams').select('id').forKeyShare().execute();
    await db.selectFrom('game_sessions').select('id').forUpdate().execute();

    expect(() =>
      recorder.assertBefore(/for key share/, /from "game_sessions".*for update/),
    ).not.toThrow();
    expect(() =>
      recorder.assertBefore(/from "game_sessions".*for update/, /for key share/),
    ).toThrow(/before/);
    expect(() => recorder.assertBefore(/missing/, /for update/)).toThrow(/never ran/);
  });

  it('reset clears the log', async () => {
    const recorder = createQueryRecorder();
    const db = dummyDatabase(recorder);
    await db.selectFrom('teams').select('id').execute();
    recorder.reset();
    expect(recorder.statements).toEqual([]);
  });
});

/**
 * `cli users set-role <email> <GLOBAL_ADMIN|PLAYER>` as the operator runs it, against a real cloned
 * database (AC-HAPPY-10): prints the id and new role (no secrets), exits 0; an unknown email or TEAM_ADMIN
 * exits non-zero and changes nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertUser } from '../helpers/factories.ts';
import { spawnNode } from '../helpers/spawn-node.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

let database: TestDatabase;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database.close();
});

async function runCli(...args: string[]): Promise<{ code: number | null; output: string }> {
  const child = spawnNode('src/cli.ts', ['users', 'set-role', ...args], {
    DATABASE_URL: database.url,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
  });
  const { code } = await child.exited;
  return { code, output: child.output() };
}

const roleOf = async (id: string): Promise<string> =>
  (await database.pool.query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [id]))
    .rows[0]?.role ?? '';

describe('cli users set-role', () => {
  it('promotes a user by email in any letter case, prints id and role and exits 0', async () => {
    const id = await insertUser(database.pool, 'MALE', { email: 'cli.admin@example.com' });
    const result = await runCli('CLI.Admin@Example.com', 'GLOBAL_ADMIN');
    expect(result.code).toBe(0);
    expect(result.output).toContain(id);
    expect(result.output).toContain('GLOBAL_ADMIN');
    expect(await roleOf(id)).toBe('GLOBAL_ADMIN');
    const demoted = await runCli('cli.admin@example.com', 'PLAYER');
    expect(demoted.code).toBe(0);
    expect(await roleOf(id)).toBe('PLAYER');
  });

  it('exits non-zero with a clear message for an unknown email and changes nothing', async () => {
    const before = await database.pool.query(
      `SELECT count(*) FROM users WHERE role = 'GLOBAL_ADMIN'`,
    );
    const result = await runCli('ghost@example.com', 'GLOBAL_ADMIN');
    expect(result.code).not.toBe(0);
    expect(result.output).toMatch(/no user/i);
    const after = await database.pool.query(
      `SELECT count(*) FROM users WHERE role = 'GLOBAL_ADMIN'`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('rejects TEAM_ADMIN as a role argument', async () => {
    const id = await insertUser(database.pool, 'FEMALE', { email: 'cli.team@example.com' });
    const result = await runCli('cli.team@example.com', 'TEAM_ADMIN');
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('TEAM_ADMIN');
    expect(await roleOf(id)).toBe('PLAYER');
  });
});

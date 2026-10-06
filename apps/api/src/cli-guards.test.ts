import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSetRoleArgs, resetRefusal, rollbackRefusal } from './cli-guards.ts';

const local = 'postgres://sgm:sgm@localhost:5432/sgm';

describe('db rollback guard', () => {
  it('refuses rollback when NODE_ENV=production and allows it elsewhere', () => {
    expect(rollbackRefusal({ nodeEnv: 'production' })).toBe(
      'db rollback is refused when NODE_ENV=production',
    );
    expect(rollbackRefusal({ nodeEnv: 'development' })).toBeUndefined();
    expect(rollbackRefusal({ nodeEnv: 'test' })).toBeUndefined();
  });

  it('cli exits 1 before touching the database when NODE_ENV=production', () => {
    const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', 'db', 'rollback'],
      {
        cwd: apiDir,
        encoding: 'utf8',
        timeout: 20_000,
        env: {
          ...process.env,
          NODE_ENV: 'production',
          // Port 1 is never a Postgres server: any DB access would fail with a connection error instead.
          DATABASE_URL: 'postgres://sgm:sgm@127.0.0.1:1/sgm?sslmode=require',
          ENCRYPTION_KEYS: `k1:${randomBytes(32).toString('base64')}`,
          ENCRYPTION_ACTIVE_KEY_ID: 'k1',
          // Production config also needs the auth settings (the CLI loads the same config as the api).
          WEB_BASE_URL: 'https://games.example.nz',
          API_INTERNAL_SHARED_SECRET: randomBytes(24).toString('base64'),
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('db rollback is refused when NODE_ENV=production');
    expect(result.stderr).not.toContain('failed:');
  });
});

describe('db reset guard', () => {
  it('refuses production and non-local hosts without --force', () => {
    expect(resetRefusal({ nodeEnv: 'production', databaseUrl: local }, [])).toBe(
      'db reset is refused when NODE_ENV=production',
    );
    expect(resetRefusal({ nodeEnv: 'development', databaseUrl: local }, [])).toBeUndefined();
    expect(
      resetRefusal(
        { nodeEnv: 'development', databaseUrl: 'postgres://u:p@db.prod.internal/x' },
        [],
      ),
    ).toContain('non-local host "db.prod.internal"');
    expect(
      resetRefusal({ nodeEnv: 'development', databaseUrl: 'postgres://u:p@db.prod.internal/x' }, [
        '--force',
      ]),
    ).toBeUndefined();
  });

  it('checks a ?host= override too, so a local-looking URL cannot target a remote server', () => {
    expect(
      resetRefusal({ nodeEnv: 'development', databaseUrl: `${local}?host=db.prod.internal` }, []),
    ).toContain('non-local host "db.prod.internal"');
    expect(
      resetRefusal(
        { nodeEnv: 'development', databaseUrl: `${local}?host=/var/run/postgresql` },
        [],
      ),
    ).toBeUndefined();
  });
});

describe('users set-role arguments (AC-HAPPY-10)', () => {
  it('accepts GLOBAL_ADMIN and PLAYER with a normalised email', () => {
    expect(parseSetRoleArgs(['Aroha@Example.com', 'GLOBAL_ADMIN'])).toEqual({
      email: 'aroha@example.com',
      role: 'GLOBAL_ADMIN',
    });
    expect(parseSetRoleArgs(['aroha@example.com', 'PLAYER'])).toEqual({
      email: 'aroha@example.com',
      role: 'PLAYER',
    });
  });

  it('rejects TEAM_ADMIN, unknown roles, a missing email and an invalid email before any database access', () => {
    expect(parseSetRoleArgs(['aroha@example.com', 'TEAM_ADMIN'])).toEqual({
      error: expect.stringContaining('TEAM_ADMIN') as string,
    });
    expect(parseSetRoleArgs(['aroha@example.com', 'ROOT'])).toHaveProperty('error');
    expect(parseSetRoleArgs(['aroha@example.com'])).toHaveProperty('error');
    expect(parseSetRoleArgs([])).toHaveProperty('error');
    expect(parseSetRoleArgs(['not-an-email', 'PLAYER'])).toHaveProperty('error');
  });
});

/**
 * Sign-in throttling against the real `auth_throttle` functions (AC-ERROR-4, AC-VERIFY-14): the 6th attempt
 * is refused without verifying, blocked attempts are not counted, the window slides exactly, success clears
 * the email row and refunds the address entry, and a forged client address cannot move an attempt.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildAuthTestApp,
  createPasswordUser,
  internalHeaders,
  login,
  STRONG_PASSWORD,
  TEST_INTERNAL_SECRET,
  type AuthTestApp,
} from '../helpers/auth-app.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.ts';

let database: TestDatabase;
let h: AuthTestApp;
beforeAll(async () => {
  database = await createTestDatabase();
  h = await buildAuthTestApp(database.pool, {
    env: { API_INTERNAL_SHARED_SECRET: TEST_INTERNAL_SECRET },
  });
});
afterAll(async () => {
  await h.close();
  await database.close();
});

const MINUTE = 60_000;
const WRONG = 'the-wrong-password-1';

async function emailRows(): Promise<number> {
  const { rows } = await database.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM auth_throttle WHERE scope = 'login_email'`,
  );
  return Number(rows[0]?.n);
}

describe('per-email throttle', () => {
  it('refuses the 6th attempt with 429 and Retry-After, even with the right password and without verifying (AC-ERROR-4)', async () => {
    const user = await createPasswordUser(h, { email: 'throttle.five@example.com' });
    const t0 = h.clock.now();
    for (let i = 0; i < 5; i += 1) {
      const failed = await login(h, user.email, WRONG);
      expect(failed.statusCode, `attempt ${i + 1}`).toBe(401);
      h.clock.advance(MINUTE);
    }
    // t0 + 5 min: the oldest failure (t0) leaves the window in 10 minutes.
    h.hasher.resetCalls();
    const blocked = await login(h, user.email, user.password);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.body).toMatchObject({ error: { code: 'too_many_attempts' } });
    expect(blocked.headers['retry-after']).toBe('600');
    expect(h.hasher.verifyCalls).toHaveLength(0); // no lookup, no hash

    // Hammering while blocked neither counts nor extends the window.
    for (let i = 0; i < 3; i += 1)
      expect((await login(h, user.email, user.password)).statusCode).toBe(429);

    // Window boundary: still blocked 1 s before t0 + 15 min, admitted exactly at it.
    h.clock.set(new Date(t0.getTime() + 15 * MINUTE - 1000));
    expect((await login(h, user.email, user.password)).statusCode).toBe(429);
    h.clock.set(new Date(t0.getTime() + 15 * MINUTE));
    expect((await login(h, user.email, user.password)).statusCode).toBe(200);
  });

  it('clears the email count on a successful sign-in (AC-ERROR-4)', async () => {
    const user = await createPasswordUser(h, { email: 'throttle.clear@example.com' });
    for (let i = 0; i < 4; i += 1) await login(h, user.email, WRONG);
    expect((await login(h, user.email, user.password)).statusCode).toBe(200);
    // Four failures were forgotten: four more are allowed before the block.
    for (let i = 0; i < 4; i += 1) expect((await login(h, user.email, WRONG)).statusCode).toBe(401);
    expect((await login(h, user.email, WRONG)).statusCode).toBe(401);
    expect((await login(h, user.email, WRONG)).statusCode).toBe(429);
  });

  it('counts failures for an unknown email exactly like a known one (no enumeration)', async () => {
    const email = 'throttle.ghost@example.com';
    for (let i = 0; i < 5; i += 1) expect((await login(h, email, WRONG)).statusCode).toBe(401);
    expect((await login(h, email, WRONG)).statusCode).toBe(429);
  });

  it('keys by the normalised email, so letter case cannot dodge the limit', async () => {
    const user = await createPasswordUser(h, { email: 'throttle.case@example.com' });
    const variants = [
      'THROTTLE.case@example.com',
      'Throttle.Case@Example.com',
      'throttle.case@example.com',
    ];
    for (let i = 0; i < 5; i += 1) await login(h, variants[i % 3] ?? user.email, WRONG);
    expect((await login(h, 'tHROTTLE.CASE@example.com', user.password)).statusCode).toBe(429);
  });

  it('stores only keyed pseudonyms: no email and no address in clear', async () => {
    await login(h, 'privacy.check@example.com', WRONG, internalHeaders('198.51.100.77'));
    const { rows } = await database.pool.query<{ scope: string; key_hash: Buffer }>(
      `SELECT scope, key_hash FROM auth_throttle`,
    );
    expect(rows.length).toBeGreaterThan(0);
    const dump = JSON.stringify((await database.pool.query(`SELECT * FROM auth_throttle`)).rows);
    expect(dump).not.toContain('privacy.check');
    expect(dump).not.toContain('198.51.100.77');
    for (const row of rows) expect(row.key_hash).toHaveLength(32);
  });
});

describe('per-address throttle and the trusted client address (AC-ERROR-4, AC-VERIFY-14)', () => {
  it('blocks the 21st failed attempt from one address across emails, and a success refunds its own entry', async () => {
    const ip = '203.0.113.50';
    const user = await createPasswordUser(h, { email: 'addr.success@example.com' });
    for (let i = 0; i < 19; i += 1) {
      const result = await login(h, `addr.spray${i}@example.com`, WRONG, internalHeaders(ip));
      expect(result.statusCode, `spray ${i}`).toBe(401);
    }
    expect((await login(h, user.email, user.password, internalHeaders(ip))).statusCode).toBe(200);
    // 19 failures + 1 refunded success = 19 counted: exactly one more failure is admitted.
    expect(
      (await login(h, 'addr.spray19@example.com', WRONG, internalHeaders(ip))).statusCode,
    ).toBe(401);
    const blocked = await login(h, 'addr.fresh@example.com', WRONG, internalHeaders(ip));
    expect(blocked.statusCode).toBe(429);
    expect(blocked.body).toMatchObject({ error: { code: 'too_many_attempts' } });
    // The address row is never cleared by a success, and another address is unaffected.
    const other = await login(h, 'addr.fresh@example.com', WRONG, internalHeaders('203.0.113.51'));
    expect(other.statusCode).toBe(401);
  });

  it('cannot be moved to another address key by X-Forwarded-For, a forged x-sgm-client-ip or a forged secret', async () => {
    const forged = (ip: string): Record<string, string> => ({
      'x-forwarded-for': ip,
      'x-sgm-client-ip': ip,
      'x-sgm-internal-auth': 'forged-secret-of-the-wrong-value-0123456789',
    });
    const addressRows = async (): Promise<number> => {
      const { rows } = await database.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM auth_throttle WHERE scope = 'login_address'`,
      );
      return Number(rows[0]?.n);
    };
    const emailRowsBefore = await emailRows();
    const addressRowsBefore = await addressRows();
    // 25 attempts from "different" addresses without the real secret: none counts against any address,
    // so none is ever blocked, and no address row is created at all.
    for (let i = 0; i < 25; i += 1) {
      const result = await login(h, `forge${i}@example.com`, WRONG, forged(`192.0.2.${i + 1}`));
      expect(result.statusCode, `forged ${i}`).toBe(401);
    }
    expect(await addressRows()).toBe(addressRowsBefore);
    expect(await emailRows()).toBe(emailRowsBefore + 25); // the email dimension still applied
  });

  it('keys addresses by the IPv6 /64 prefix', async () => {
    for (let i = 0; i < 20; i += 1) {
      await login(
        h,
        `v6.spray${i}@example.com`,
        WRONG,
        internalHeaders(`2001:db8:aa:bb::${i + 1}`),
      );
    }
    const blocked = await login(
      h,
      'v6.next@example.com',
      WRONG,
      internalHeaders('2001:db8:aa:bb:ffff:ffff:ffff:ffff'),
    );
    expect(blocked.statusCode).toBe(429);
  });
});

describe('throttle store outage', () => {
  it('fails closed with 503 service_unavailable and never verifies a password without the throttle', async () => {
    const broken = await createTestDatabase();
    const harness = await buildAuthTestApp(broken.pool);
    try {
      await broken.pool.query(
        `DROP FUNCTION auth_throttle_admit(text[], bytea[], integer[], interval[], timestamptz)`,
      );
      const result = await login(harness, 'outage@example.com', STRONG_PASSWORD);
      expect(result.statusCode).toBe(503);
      expect(harness.hasher.verifyCalls).toHaveLength(0);
    } finally {
      await harness.close();
      await broken.close();
    }
  });
});

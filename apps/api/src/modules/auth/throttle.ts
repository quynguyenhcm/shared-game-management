/**
 * Sign-in and forgot-password throttling over the `auth_throttle` table and its two functions (algorithm Q7,
 * option 7A): a Postgres sliding log shared by every API replica, reserve-then-verify, HMAC-keyed so no email
 * or address is stored in clear. Time always comes from the caller (the injected clock), never from SQL.
 */
import { createHmac, hkdfSync } from 'node:crypto';
import { isIP } from 'node:net';
import { sql } from 'kysely';
import type { AuthConfig } from '../../lib/config/config.ts';
import type { KeyProvider } from '../../lib/crypto/keyring.ts';
import type { Database } from '../../lib/db/kysely.ts';
import { AppError } from '../../lib/http/errors.ts';

export type ThrottleScope = 'login_email' | 'login_address' | 'forgot_address' | 'register_address';

export interface ThrottleKeys {
  /** Normalised email, or the sentinel for an input that does not normalise. */
  readonly email: string;
  /** `request.clientAddress`; `null` skips the address dimension. */
  readonly clientAddress: string | null;
}

export type ThrottleVerdict =
  | { readonly admitted: true }
  | {
      readonly admitted: false;
      readonly retryAfterSeconds: number;
      /** Which dimension blocked (email wins when both did); only used for the log reason. */
      readonly blockedBy: 'email' | 'address';
    };

export interface LoginThrottle {
  /** Before any lookup or hash: reserves a provisional failure on every key, or denies (429). */
  admitLogin(keys: ThrottleKeys, now: Date): Promise<ThrottleVerdict>;
  /** Successful sign-in: delete the email row and refund this attempt's address entry. */
  settleLogin(keys: ThrottleKeys, now: Date): Promise<void>;
  /** Forgot-password address limit. A `null` address is admitted (the address dimension is skipped). */
  admitForgot(clientAddress: string | null, now: Date): Promise<ThrottleVerdict>;
  /** Registration address limit (its own scope, so it never spends the sign-in or forgot budget). */
  admitRegister(clientAddress: string | null, now: Date): Promise<ThrottleVerdict>;
  /** A completed reset: delete the email row inside the reset transaction. */
  clearEmail(email: string, trx: Pick<Database, 'deleteFrom'>): Promise<void>;
}

export interface LoginThrottleOptions {
  readonly db: Database;
  readonly keys: KeyProvider;
  readonly config: Pick<
    AuthConfig,
    | 'loginMaxFailuresPerEmail'
    | 'loginMaxFailuresPerAddress'
    | 'loginWindowMinutes'
    | 'forgotMaxPerAddress'
    | 'registerMaxPerAddress'
  >;
}

const FORGOT_WINDOW_MINUTES = 60;
const REGISTER_WINDOW_MINUTES = 60;
const HKDF_INFO = 'sgm:v1:auth-throttle';

/** `K_throttle = HKDF-SHA256(active encryption key, info = "sgm:v1:auth-throttle")`: no new secret to manage. */
export function deriveThrottleSecret(activeKey: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', activeKey, Buffer.alloc(0), HKDF_INFO, 32));
}

/** `HMAC-SHA256(K_throttle, scope || 0x00 || value)`. */
export function deriveThrottleKey(secret: Buffer, scope: ThrottleScope, value: string): Buffer {
  return createHmac('sha256', secret)
    .update(scope)
    .update(Buffer.from([0]))
    .update(value)
    .digest();
}

/** Expands an IPv6 address to eight 16-bit groups, or `null` when it is not valid IPv6. */
function ipv6Groups(address: string): number[] | null {
  const [head = '', tail, ...rest] = address.split('::');
  if (rest.length > 0) return null;
  const toGroups = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const left = toGroups(head);
  const right = tail === undefined ? [] : toGroups(tail);
  // A trailing dotted IPv4 (::ffff:1.2.3.4) occupies two groups.
  const expandV4 = (groups: string[]): string[] => {
    const last = groups[groups.length - 1];
    if (last === undefined || !last.includes('.')) return groups;
    const octets = last.split('.').map(Number);
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
      return ['x'];
    }
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    return [...groups.slice(0, -1), ((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
  };
  const l = expandV4(left);
  const r = tail === undefined ? [] : expandV4(right);
  const missing = 8 - l.length - r.length;
  if ((tail === undefined && missing !== 0) || missing < 0) return null;
  const full = tail === undefined ? l : [...l, ...Array<string>(missing).fill('0'), ...r];
  const groups = full.map((group) => Number.parseInt(group, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : null;
}

/**
 * The throttle value for a client address: IPv4 as is, an IPv4-mapped IPv6 address as its IPv4, and any other
 * IPv6 address as its /64 prefix (one customer's whole delegated prefix is one key). `null` if not an IP.
 */
export function truncateAddress(address: string): string | null {
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6) return null;
  const groups = ipv6Groups(address.toLowerCase());
  if (groups === null) return null;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
  }
  const hex = (n: number): string => n.toString(16).padStart(4, '0');
  return `${hex(g0)}:${hex(g1)}:${hex(g2)}:${hex(g3)}::/64`;
}

interface AdmitRow {
  readonly admitted: boolean;
  readonly retry_after_seconds: number;
}

export function createLoginThrottle(options: LoginThrottleOptions): LoginThrottle {
  const { db, config } = options;
  const activeKey = options.keys.getKey(options.keys.activeKeyId);
  if (activeKey === undefined) throw new Error('throttle: the active encryption key is missing');
  const secret = deriveThrottleSecret(activeKey);
  const loginWindowSeconds = config.loginWindowMinutes * 60;

  const addressKey = (scope: ThrottleScope, address: string | null): Buffer | null => {
    const truncated = address === null ? null : truncateAddress(address);
    return truncated === null ? null : deriveThrottleKey(secret, scope, truncated);
  };

  /** Fails closed (503): a password is never verified without the throttle (algorithm, Error Handling). */
  async function admit(
    entries: readonly { scope: ThrottleScope; key: Buffer; limit: number; windowSeconds: number }[],
    now: Date,
  ): Promise<AdmitRow> {
    try {
      const result = await sql<AdmitRow>`
        SELECT admitted, retry_after_seconds
          FROM auth_throttle_admit(
            ${entries.map((e) => e.scope)}::text[],
            ${entries.map((e) => e.key)}::bytea[],
            ${entries.map((e) => e.limit)}::integer[],
            ${entries.map((e) => `${e.windowSeconds} seconds`)}::interval[],
            ${now}::timestamptz)`.execute(db);
      const row = result.rows[0];
      if (row === undefined) throw new Error('auth_throttle_admit returned no row');
      return row;
    } catch (error) {
      throw new AppError('service_unavailable', { cause: error });
    }
  }

  /** One address-only dimension (forgot, register). A `null` address is admitted: the dimension is skipped. */
  async function admitAddress(
    scope: 'forgot_address' | 'register_address',
    clientAddress: string | null,
    limit: number,
    windowMinutes: number,
    now: Date,
  ): Promise<ThrottleVerdict> {
    const key = addressKey(scope, clientAddress);
    if (key === null) return { admitted: true };
    const row = await admit([{ scope, key, limit, windowSeconds: windowMinutes * 60 }], now);
    return row.admitted
      ? { admitted: true }
      : { admitted: false, retryAfterSeconds: row.retry_after_seconds, blockedBy: 'address' };
  }

  return {
    async admitLogin(keys, now) {
      const emailKey = deriveThrottleKey(secret, 'login_email', keys.email);
      const addrKey = addressKey('login_address', keys.clientAddress);
      const entries = [
        {
          scope: 'login_email' as const,
          key: emailKey,
          limit: config.loginMaxFailuresPerEmail,
          windowSeconds: loginWindowSeconds,
        },
        ...(addrKey === null
          ? []
          : [
              {
                scope: 'login_address' as const,
                key: addrKey,
                limit: config.loginMaxFailuresPerAddress,
                windowSeconds: loginWindowSeconds,
              },
            ]),
      ];
      const row = await admit(entries, now);
      if (row.admitted) return { admitted: true };
      // The admit function pruned and persisted the rows, so a read tells which dimension is at its limit.
      let emailBlocked = true;
      try {
        const rows = await db
          .selectFrom('auth_throttle')
          .select(['scope', sql<number>`cardinality(attempts)`.as('count')])
          .where('key_hash', '=', emailKey)
          .where('scope', '=', 'login_email')
          .execute();
        emailBlocked = (rows[0]?.count ?? 0) >= config.loginMaxFailuresPerEmail;
      } catch {
        // Only the log reason depends on this read; the verdict stands.
      }
      return {
        admitted: false,
        retryAfterSeconds: row.retry_after_seconds,
        blockedBy: emailBlocked || addrKey === null ? 'email' : 'address',
      };
    },

    async settleLogin(keys, now) {
      const emailKey = deriveThrottleKey(secret, 'login_email', keys.email);
      const addrKey = addressKey('login_address', keys.clientAddress);
      try {
        await sql`SELECT auth_throttle_settle(${emailKey}::bytea, ${addrKey}::bytea, ${now}::timestamptz)`.execute(
          db,
        );
      } catch (error) {
        throw new AppError('service_unavailable', { cause: error });
      }
    },

    admitForgot: (clientAddress, now) =>
      admitAddress(
        'forgot_address',
        clientAddress,
        config.forgotMaxPerAddress,
        FORGOT_WINDOW_MINUTES,
        now,
      ),

    admitRegister: (clientAddress, now) =>
      admitAddress(
        'register_address',
        clientAddress,
        config.registerMaxPerAddress,
        REGISTER_WINDOW_MINUTES,
        now,
      ),

    async clearEmail(email, trx) {
      await trx
        .deleteFrom('auth_throttle')
        .where('scope', '=', 'login_email')
        .where('key_hash', '=', deriveThrottleKey(secret, 'login_email', email))
        .execute();
    },
  };
}

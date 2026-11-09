/**
 * Opaque keyset cursors for `(timestamp, id)` orderings (wallet ledger, the payer's payment lists). The timestamp travels as the
 * exact text Postgres formatted (microseconds, UTC) so the keyset never drops precision; the id is a uuid. An unreadable cursor is
 * a 422 on the `cursor` field, and nothing from it reaches SQL unchecked.
 */
import { AppError } from './errors.ts';

export interface KeysetPosition {
  /** `YYYY-MM-DDTHH24:MI:SS.USZ`, as `KEYSET_TIME_FORMAT` produces it. */
  readonly at: string;
  readonly id: string;
}

/** The `to_char` format of a `timestamptz AT TIME ZONE 'UTC'` for a cursor. */
export const KEYSET_TIME_FORMAT = `YYYY-MM-DD"T"HH24:MI:SS.US"Z"`;

const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function encodeKeysetCursor(position: KeysetPosition): string {
  return Buffer.from(JSON.stringify({ t: position.at, i: position.id })).toString('base64url');
}

export function decodeKeysetCursor(cursor: string): KeysetPosition {
  const invalid = new AppError('validation_failed', {
    fieldErrors: { cursor: ['That page link is not valid. Start again from the first page.'] },
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid;
  }
  const { t, i } = (parsed ?? {}) as { t?: unknown; i?: unknown };
  if (typeof t !== 'string' || typeof i !== 'string' || !AT.test(t) || !ID.test(i)) throw invalid;
  if (Number.isNaN(Date.parse(t))) throw invalid;
  return { at: t, id: i };
}

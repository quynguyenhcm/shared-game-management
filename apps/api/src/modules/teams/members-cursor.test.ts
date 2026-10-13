/** The admin member-list cursor: opaque, versioned, strict, and bound to the section (status) it was issued for. */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeMembersCursor, encodeMembersCursor, type MembersCursor } from './members-cursor.ts';

const id = randomUUID();

const cursors: MembersCursor[] = [
  { v: 1, s: 'PENDING', t: '2026-10-13 01:02:03.456789+00', i: id },
  { v: 1, s: 'APPROVED', r: 0, n: 'zoë ünïcode', i: id },
  { v: 1, s: 'BANNED', t: '2026-10-13 01:02:03.456789+00', i: id },
];

describe('members cursor', () => {
  it.each(cursors)('round-trips the $s cursor, including non-ASCII names', (cursor) => {
    const encoded = encodeMembersCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeMembersCursor(encoded, cursor.s)).toEqual(cursor);
  });

  it('refuses a cursor issued for another section', () => {
    const pending = encodeMembersCursor(cursors[0] as MembersCursor);
    expect(decodeMembersCursor(pending, 'BANNED')).toBeNull();
  });

  it.each([
    ['not base64 json', '!!!'],
    ['json of the wrong shape', Buffer.from('{"v":1}').toString('base64url')],
    [
      'an unknown version',
      Buffer.from(JSON.stringify({ ...cursors[0], v: 2 })).toString('base64url'),
    ],
    [
      'an unexpected extra key',
      Buffer.from(JSON.stringify({ ...cursors[0], extra: 1 })).toString('base64url'),
    ],
    ['a non-uuid id', Buffer.from(JSON.stringify({ ...cursors[0], i: 'x' })).toString('base64url')],
    [
      'an unparseable timestamp',
      Buffer.from(JSON.stringify({ ...cursors[0], t: 'soon' })).toString('base64url'),
    ],
  ])('returns null for %s', (_label, value) => {
    expect(decodeMembersCursor(value, 'PENDING')).toBeNull();
  });
});

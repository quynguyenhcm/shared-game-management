import { describe, expect, it } from 'vitest';
import { decodeKeysetCursor, encodeKeysetCursor } from './cursor.ts';
import { AppError } from './errors.ts';

const POSITION = { at: '2026-11-10T00:00:00.123456Z', id: '3b241101-e2bb-4255-8caf-4136c566a962' };

describe('keyset cursors', () => {
  it('round-trips the exact timestamp text and the id', () => {
    expect(decodeKeysetCursor(encodeKeysetCursor(POSITION))).toEqual(POSITION);
  });

  it('refuses anything else as a 422 on the cursor field', () => {
    const forged = Buffer.from(JSON.stringify({ t: "x' OR 1=1", i: POSITION.id })).toString(
      'base64url',
    );
    const impossible = Buffer.from(
      JSON.stringify({ t: '2026-99-99T99:99:99.999999Z', i: POSITION.id }),
    ).toString('base64url');
    for (const cursor of ['garbage', forged, impossible, Buffer.from('[]').toString('base64url')]) {
      try {
        decodeKeysetCursor(cursor);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).fieldErrors).toHaveProperty('cursor');
      }
    }
  });
});

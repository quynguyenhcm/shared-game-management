import { describe, expect, it } from 'vitest';
import {
  AKAHU_STATUS_MATRIX,
  AKAHU_STATUS_MATRIX_PROVENANCE,
} from '../../../test/fixtures/akahu-status-matrix.ts';
import { mapAkahuStatus } from './status.ts';

describe('mapAkahuStatus (A2)', () => {
  it('replays every row of the status matrix fixture', () => {
    expect(AKAHU_STATUS_MATRIX_PROVENANCE).toBe('vendor-doc-derived');
    expect(AKAHU_STATUS_MATRIX.filter((row) => !row.documented)).toHaveLength(2);
    for (const row of AKAHU_STATUS_MATRIX) {
      expect(mapAkahuStatus(row.status, row.reason), `${row.status}/${row.reason}`).toEqual(
        row.outcome,
      );
    }
  });

  it('treats SENT as the only success whatever the reason, and an unknown FAILED reason as unrecognised', () => {
    expect(mapAkahuStatus('SENT', 'ANYTHING')).toEqual({ kind: 'SUCCEEDED' });
    expect(mapAkahuStatus('FAILED', null)).toEqual({ kind: 'UNRECOGNISED' });
    expect(mapAkahuStatus('sent', null)).toEqual({ kind: 'UNRECOGNISED' });
    const successes = AKAHU_STATUS_MATRIX.filter((row) => row.outcome.kind === 'SUCCEEDED');
    expect(successes.map((row) => row.status)).toEqual(['SENT']);
  });
});

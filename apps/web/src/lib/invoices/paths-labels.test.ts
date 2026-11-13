import { describe, expect, it } from 'vitest';
import {
  ADMIN_ACTION_TEXT,
  actionText,
  adminActionName,
  downloadErrorMessage,
  playerActionName,
} from './labels.ts';
import {
  DOWNLOAD_ERROR_CODES,
  myDocumentPath,
  parseDownloadError,
  teamDocumentPath,
  withDownloadError,
} from './paths.ts';

const ID = '22222222-2222-4222-8222-222222222222';
const TEAM = '7f3c2b1a-1111-4222-8333-444455556666';

describe('invoice download paths', () => {
  it('builds the payer and team-admin links, encoding the page an error returns to', () => {
    expect(myDocumentPath(ID)).toBe(`/payments/${ID}/invoice`);
    expect(myDocumentPath(ID, `/teams/${TEAM}/wallet?payments=all`)).toBe(
      `/payments/${ID}/invoice?returnTo=${encodeURIComponent(`/teams/${TEAM}/wallet?payments=all`)}`,
    );
    expect(teamDocumentPath(TEAM, ID, `/teams/${TEAM}/manage/payments?status=paid`)).toBe(
      `/teams/${TEAM}/manage/payments/${ID}/invoice?returnTo=${encodeURIComponent(`/teams/${TEAM}/manage/payments?status=paid`)}`,
    );
  });

  it('sets download_error on a landing path, keeping other parameters and replacing an older code', () => {
    expect(withDownloadError('/payments/x', 'not_found')).toBe(
      '/payments/x?download_error=not_found',
    );
    expect(withDownloadError('/w?payments=all&download_error=not_found', 'invoice_pending')).toBe(
      '/w?payments=all&download_error=invoice_pending',
    );
  });

  it('accepts only the known codes, so a crafted value renders nothing', () => {
    for (const code of DOWNLOAD_ERROR_CODES) expect(parseDownloadError(code)).toBe(code);
    for (const bad of [null, undefined, '', '<script>', 'internal_error']) {
      expect(parseDownloadError(bad)).toBeNull();
    }
  });
});

describe('invoice download copy (the words come from the shared document copy)', () => {
  it('labels the action from the document kind and names the file type, game and amount', () => {
    expect(actionText('TAX_INVOICE')).toBe('Download tax invoice');
    expect(actionText('RECEIPT')).toBe('Download receipt');
    expect(
      playerActionName('RECEIPT', {
        location: 'Rosedale Hall',
        day: 'Wed 7 Oct',
        amount: '$17.00',
      }),
    ).toBe('Download receipt for Rosedale Hall, Wed 7 Oct, $17.00 (PDF)');
    expect(ADMIN_ACTION_TEXT).toBe('Invoice');
    expect(adminActionName({ player: 'Priya Shah', day: 'Wed 7 Oct', amount: '$17.00' })).toBe(
      'Invoice for Priya Shah, Wed 7 Oct, $17.00 (PDF)',
    );
  });

  it('says what happened for every landing code', () => {
    expect(downloadErrorMessage('invoice_not_available')).toBe(
      'An invoice is available once the payment is paid.',
    );
    expect(downloadErrorMessage('not_found')).toBe("We couldn't find this payment.");
    expect(downloadErrorMessage('invoice_pending', { kind: 'RECEIPT' })).toBe(
      'Your receipt is being prepared. Try again in a moment.',
    );
    expect(downloadErrorMessage('service_unavailable', { kind: 'TAX_INVOICE' })).toBe(
      "We couldn't download your tax invoice. Try again in a minute.",
    );
    expect(downloadErrorMessage('service_unavailable', { admin: true })).toBe(
      "We couldn't download this invoice. Try again in a minute.",
    );
    expect(downloadErrorMessage('forbidden')).toBe("You don't have access to this invoice.");
  });
});

import { describe, expect, it } from 'vitest';
import { toMoneyString, parseMoney } from '../money/money.ts';
import {
  AMOUNT_COLUMN_LABELS,
  DOCUMENT_ACTION_LABELS,
  DOCUMENT_NUMBER_LABELS,
  DOCUMENT_TITLES,
  agentLine,
  gameFeeLine,
  gstLabel,
  gstNumberLine,
  gstRatePercent,
  gstSentence,
  lateWithdrawalLine,
} from './document-copy.ts';

describe('document copy (all accountant-sensitive wording in one place)', () => {
  it('words the two document kinds and the agent line (H1, H2)', () => {
    expect(DOCUMENT_TITLES).toEqual({ TAX_INVOICE: 'Tax invoice', RECEIPT: 'Receipt' });
    expect(DOCUMENT_NUMBER_LABELS.RECEIPT).toBe('Receipt number');
    expect(AMOUNT_COLUMN_LABELS.TAX_INVOICE).toBe('Amount (including GST)');
    expect(agentLine('Hōkio Badminton Club')).toBe(
      'Issued by Shared Game Management on behalf of Hōkio Badminton Club.',
    );
    // The receipt wording says nothing about tax anywhere (H2).
    expect(
      `${DOCUMENT_TITLES.RECEIPT} ${DOCUMENT_NUMBER_LABELS.RECEIPT} ${AMOUNT_COLUMN_LABELS.RECEIPT}`,
    ).not.toMatch(/tax|gst/i);
  });

  it('prints the GST number in IRD grouping and the rate as a percent', () => {
    expect(gstNumberLine('49091850')).toBe('GST number 49-091-850');
    expect(gstNumberLine('136410132')).toBe('GST number 136-410-132');
    expect(gstRatePercent(1500)).toBe('15');
    expect(gstRatePercent(1250)).toBe('12.5');
    expect(gstLabel(1500)).toBe('GST (15%)');
    expect(gstSentence(toMoneyString(parseMoney('4.83')))).toBe('The total includes GST of $4.83.');
  });

  it('describes game-fee and late-withdrawal lines for the registrant and guests (AC-HAPPY-2, AC-ERROR-6)', () => {
    expect(gameFeeLine(0)).toBe('Game fee, player');
    expect(gameFeeLine(2)).toBe('Game fee, guest 2');
    expect(lateWithdrawalLine(0, 'Hōkio Sports Hall', '3 June 2027')).toBe(
      'Late withdrawal fee, Hōkio Sports Hall, 3 June 2027',
    );
    expect(lateWithdrawalLine(1, 'Hall', '3 June 2027')).toBe(
      'Late withdrawal fee, guest 1, Hall, 3 June 2027',
    );
  });

  it('labels the download action from the document kind, never from a GST amount', () => {
    expect(DOCUMENT_ACTION_LABELS).toEqual({
      TAX_INVOICE: 'Download tax invoice',
      RECEIPT: 'Download receipt',
    });
  });
});

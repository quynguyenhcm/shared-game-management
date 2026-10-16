import { describe, expect, it } from 'vitest';
import { validateEmailMessage } from '../../lib/notifications/notifier.ts';
import { buildBankingChangedEmail } from './emails.ts';

const base = {
  to: 'kiri@example.test',
  recipientName: 'Kiri Colleague',
  teamName: 'Notified Team',
  teamId: '11111111-1111-4111-8111-111111111111',
  actorName: 'Hana\nActor',
  when: new Date('2026-10-06T01:30:00Z'),
  webBaseUrl: 'https://games.example.nz',
  changeKey: '22222222-2222-4222-8222-222222222222',
  recipientId: '33333333-3333-4333-8333-333333333333',
} as const;

describe('buildBankingChangedEmail (R8 copy rules)', () => {
  it('names who changed what and when, links to the page, and carries no value; it passes message validation', () => {
    const message = buildBankingChangedEmail({
      ...base,
      kind: 'saved',
      changedFields: ['accountName', 'accountNumber'],
    });
    expect(message.to).toBe(base.to);
    expect(message.idempotencyKey).toBe(
      `banking-changed:${base.teamId}:${base.changeKey}:${base.recipientId}`,
    );
    expect(message.text).toContain('Hana Actor');
    expect(message.text).toContain('Notified Team');
    expect(message.text).toContain('account name and account number');
    // 01:30 UTC is 14:30 in Auckland (NZDT, UTC+13).
    expect(message.text).toContain('06/10/2026 2:30 pm');
    expect(message.text).toContain(`https://games.example.nz/teams/${base.teamId}/manage/banking`);
    expect(message.subject).not.toMatch(/[\r\n]/);
    expect(() => validateEmailMessage(message, 'test')).not.toThrow();
  });

  it('words a removal without a field list', () => {
    const message = buildBankingChangedEmail({ ...base, kind: 'removed', changedFields: [] });
    expect(message.text).toContain('removed');
    expect(message.text).not.toContain('account name');
    expect(message.tags).toEqual({ template: 'banking-changed' });
  });
});

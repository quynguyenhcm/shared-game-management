/**
 * AC-INTEGRATION-3: a message sent through the dev (smtp) adapter really arrives in Mailpit.
 * The adapter's return value and log lines do not count; only Mailpit's own API does.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/lib/config/config.ts';
import { createNotifier } from '../../src/lib/notifications/notifier.ts';
import { waitFor } from '../helpers/wait-for.ts';

const config = loadConfig();

interface MailpitMessage {
  ID: string;
  Subject: string;
  To: { Address: string }[];
  From: { Address: string };
}

async function mailpit<T>(path: string): Promise<T> {
  const response = await fetch(new URL(path, config.mailpitApiUrl));
  expect(response.ok, `${path} -> ${response.status}`).toBe(true);
  return (await response.json()) as T;
}

describe('smtp adapter -> Mailpit (AC-INTEGRATION-3)', () => {
  it('delivers exactly one message with the unique subject and expected recipient within 5 s', async () => {
    const notifier = createNotifier({
      notifierAdapter: 'smtp',
      smtpUrl: config.smtpUrl,
      emailFrom: config.emailFrom,
    });
    const token = randomUUID();
    const subject = `foundation-smoke-${token}`;
    const to = `player-${token}@example.test`;

    const result = await notifier.send({
      to,
      subject,
      text: 'Smoke test body',
      html: '<p>Smoke test body</p>',
      idempotencyKey: `foundation-smoke:${token}`,
      tags: { template: 'smoke' },
    });
    expect(result.providerMessageId).toEqual(expect.any(String));

    const found = await waitFor(
      async () => {
        const { messages } = await mailpit<{ messages: MailpitMessage[] }>(
          '/api/v1/messages?limit=100',
        );
        const matches = messages.filter((message) => message.Subject === subject);
        return matches.length > 0 ? matches : undefined;
      },
      { timeoutMs: 5_000, intervalMs: 100, label: `Mailpit to list ${subject}` },
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.To.map((address) => address.Address)).toEqual([to]);

    const search = await mailpit<{ messages_count: number }>(
      `/api/v1/search?query=${encodeURIComponent(`subject:"${subject}"`)}`,
    );
    expect(search.messages_count).toBe(1);

    const headers = await mailpit<Record<string, string[]>>(
      `/api/v1/message/${found[0]?.ID}/headers`,
    );
    expect(headers['X-Idempotency-Key']).toEqual([`foundation-smoke:${token}`]);
  });
});

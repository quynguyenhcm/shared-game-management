import { describe, expect, it, vi } from 'vitest';
import { createInMemoryNotifier } from './adapters/in-memory.ts';
import {
  createSmtpNotifier,
  mapSmtpError,
  smtpTransportOptions,
  type SmtpTransport,
} from './adapters/smtp.ts';
import {
  NotificationError,
  NotifierConfigurationError,
  PermanentDeliveryError,
  TransientDeliveryError,
} from './errors.ts';
import {
  createNotifier,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_SUBJECT_LENGTH,
  type EmailMessage,
  type Notifier,
} from './notifier.ts';

const baseMessage: EmailMessage = {
  to: 'player@example.test',
  subject: 'Game night',
  text: 'See you Thursday',
  idempotencyKey: 'test:1',
};

function fakeTransport(
  behaviour: (options: Record<string, unknown>) => Promise<{ messageId: string }>,
): SmtpTransport & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    sendMail: vi.fn((options: Record<string, unknown>) => {
      calls.push(options);
      return behaviour(options);
    }),
  };
}

const okTransport = () => fakeTransport(() => Promise.resolve({ messageId: '<abc@smtp.test>' }));

const config = {
  smtpUrl: 'smtp://localhost:1025',
  emailFrom: 'Shared Game Management <no-reply@example.test>',
};

/** Calling code that is identical under every adapter (AC-VERIFY-16). */
async function sendThrough(notifier: Notifier): Promise<Awaited<ReturnType<Notifier['send']>>> {
  return notifier.send({ ...baseMessage, tags: { template: 'unit' } });
}

describe('notifier contract parity (AC-VERIFY-16)', () => {
  it('resolves to { providerMessageId, acceptedAt, deduplicated } under smtp and memory alike', async () => {
    const smtp = createNotifier(
      { ...config, notifierAdapter: 'smtp' },
      { smtpTransport: okTransport() },
    );
    const memory = createNotifier({ ...config, notifierAdapter: 'memory' });
    for (const notifier of [smtp, memory]) {
      const result = await sendThrough(notifier);
      expect(result.providerMessageId).toEqual(expect.any(String));
      expect(result.providerMessageId.length).toBeGreaterThan(0);
      expect(result.acceptedAt).toBeInstanceOf(Date);
      expect(result.deduplicated).toBe(false);
    }
  });

  it('selects the adapter purely from configuration and rejects unknown adapters', () => {
    const memory = createNotifier({ ...config, notifierAdapter: 'memory' });
    expect('sent' in memory).toBe(true);
    const smtp = createNotifier(
      { ...config, notifierAdapter: 'smtp' },
      { smtpTransport: okTransport() },
    );
    expect('sent' in smtp).toBe(false);
    expect(() =>
      createNotifier({ ...config, notifierAdapter: 'postmark' as unknown as 'smtp' }),
    ).toThrow(NotifierConfigurationError);
  });
});

describe('message validation (both adapters)', () => {
  const adapters: [string, () => Notifier][] = [
    ['memory', () => createInMemoryNotifier()],
    ['smtp', () => createSmtpNotifier({ ...config, transport: okTransport() })],
  ];

  it.each(adapters)('%s rejects invalid messages with PermanentDeliveryError', async (_n, make) => {
    const notifier = make();
    const invalid: Partial<EmailMessage>[] = [
      { subject: 'line1\r\nBcc: evil@example.test' },
      { subject: 'x'.repeat(MAX_SUBJECT_LENGTH + 1) },
      { to: 'a@example.test, b@example.test' },
      { to: 'a@example.test;b@example.test' },
      { to: 'not-an-address' },
      { to: 'a@example.test\r\nBcc: b@example.test' },
      { idempotencyKey: '' },
      { idempotencyKey: 'k'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1) },
      { from: 'a@example.test,b@example.test' },
      { replyTo: 'nope' },
      { tags: { 'bad key': 'v' } },
      { tags: { template: 'line\nbreak' } },
      { html: { path: '/etc/passwd' } as unknown as string },
      { html: 42 as unknown as string },
    ];
    for (const override of invalid) {
      const error = await notifier.send({ ...baseMessage, ...override }).catch((e: unknown) => e);
      expect(error, JSON.stringify(override)).toBeInstanceOf(PermanentDeliveryError);
      expect((error as NotificationError).retryable).toBe(false);
    }
    const missingKey: Record<string, unknown> = { ...baseMessage };
    delete missingKey.idempotencyKey;
    await expect(notifier.send(missingKey as unknown as EmailMessage)).rejects.toBeInstanceOf(
      PermanentDeliveryError,
    );
    await expect(
      notifier.send({ ...baseMessage, text: undefined as unknown as string }),
    ).rejects.toBeInstanceOf(PermanentDeliveryError);
  });

  it('accepts a subject of exactly the maximum length and a display-name address', async () => {
    const notifier = createInMemoryNotifier();
    await notifier.send({
      ...baseMessage,
      subject: 'x'.repeat(MAX_SUBJECT_LENGTH),
      to: 'Sam Player <sam@example.test>',
    });
    expect(notifier.sent).toHaveLength(1);
  });
});

describe('in-memory adapter', () => {
  it('captures messages with the resolved sender and exposes them to tests', async () => {
    const notifier = createInMemoryNotifier({ defaultFrom: 'Club <club@example.test>' });
    const result = await notifier.send({
      ...baseMessage,
      html: '<p>hi</p>',
      replyTo: 'r@example.test',
    });
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]).toMatchObject({
      to: 'player@example.test',
      from: 'Club <club@example.test>',
      subject: 'Game night',
      html: '<p>hi</p>',
      replyTo: 'r@example.test',
      idempotencyKey: 'test:1',
      providerMessageId: result.providerMessageId,
    });
    notifier.reset();
    expect(notifier.sent).toHaveLength(0);
  });

  it('dedupes by idempotencyKey and reports deduplicated: true without capturing twice', async () => {
    const notifier = createInMemoryNotifier();
    const first = await notifier.send(baseMessage);
    const second = await notifier.send({ ...baseMessage, subject: 'changed but same key' });
    expect(second.deduplicated).toBe(true);
    expect(second.providerMessageId).toBe(first.providerMessageId);
    expect(notifier.sent).toHaveLength(1);
    await notifier.send({ ...baseMessage, idempotencyKey: 'test:2' });
    expect(notifier.sent).toHaveLength(2);
  });

  it('throws each typed error class when configured to fail, and recovers when cleared', async () => {
    const notifier = createInMemoryNotifier();
    notifier.failWith('transient');
    const transient = await notifier.send(baseMessage).catch((e: unknown) => e);
    expect(transient).toBeInstanceOf(TransientDeliveryError);
    expect(transient).toMatchObject({ retryable: true, adapter: 'memory' });
    notifier.failWith('permanent');
    const permanent = await notifier.send(baseMessage).catch((e: unknown) => e);
    expect(permanent).toBeInstanceOf(PermanentDeliveryError);
    expect(permanent).toMatchObject({ retryable: false });
    notifier.failWith('configuration');
    const configuration = await notifier.send(baseMessage).catch((e: unknown) => e);
    expect(configuration).toBeInstanceOf(NotifierConfigurationError);
    expect(configuration).toMatchObject({ retryable: false });
    expect(notifier.sent).toHaveLength(0);
    notifier.failWith(undefined);
    await expect(notifier.send(baseMessage)).resolves.toMatchObject({ deduplicated: false });
  });
});

describe('typed errors', () => {
  it('share the NotificationError base with retryable, adapter and providerCode', () => {
    const errors = [
      new TransientDeliveryError('t', { adapter: 'x', providerCode: '421' }),
      new PermanentDeliveryError('p', { adapter: 'x' }),
      new NotifierConfigurationError('c', { adapter: 'x' }),
    ];
    for (const error of errors) expect(error).toBeInstanceOf(NotificationError);
    expect(errors.map((error) => error.retryable)).toEqual([true, false, false]);
    expect(errors[0]).toMatchObject({
      adapter: 'x',
      providerCode: '421',
      name: 'TransientDeliveryError',
    });
  });
});

describe('smtp adapter', () => {
  it('builds a transport that can never read local files or fetch URLs for content', () => {
    expect(smtpTransportOptions('smtp://localhost:1025')).toMatchObject({
      url: 'smtp://localhost:1025',
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  });

  it('sends one recipient with X-Idempotency-Key, tag headers and the default sender', async () => {
    const transport = okTransport();
    const notifier = createSmtpNotifier({ ...config, transport });
    const result = await notifier.send({
      ...baseMessage,
      html: '<p>x</p>',
      replyTo: 'r@example.test',
      tags: { template: 'low-credit' },
    });
    expect(result).toMatchObject({ providerMessageId: '<abc@smtp.test>', deduplicated: false });
    expect(transport.calls).toHaveLength(1);
    const mail = transport.calls[0] as Record<string, unknown> & {
      headers: Record<string, string>;
    };
    expect(mail).toMatchObject({
      from: config.emailFrom,
      to: 'player@example.test',
      subject: 'Game night',
      text: 'See you Thursday',
      html: '<p>x</p>',
      replyTo: 'r@example.test',
    });
    expect(mail.headers['X-Idempotency-Key']).toBe('test:1');
    expect(mail.headers['X-Tag-template']).toBe('low-credit');
  });

  it('maps SMTP and network failures onto the typed error classes', () => {
    const cases: [
      Record<string, unknown>,
      new (...args: never[]) => NotificationError,
      string | undefined,
    ][] = [
      [{ code: 'ECONNECTION', message: 'refused' }, TransientDeliveryError, 'ECONNECTION'],
      [{ code: 'ETIMEDOUT', message: 'timeout' }, TransientDeliveryError, 'ETIMEDOUT'],
      [{ code: 'ESOCKET', message: 'reset' }, TransientDeliveryError, 'ESOCKET'],
      [{ code: 'EDNS', message: 'dns' }, TransientDeliveryError, 'EDNS'],
      [{ code: 'EENVELOPE', responseCode: 421, message: 'busy' }, TransientDeliveryError, '421'],
      [{ responseCode: 450, message: 'mailbox busy' }, TransientDeliveryError, '450'],
      [{ responseCode: 550, message: 'no such user' }, PermanentDeliveryError, '550'],
      [{ code: 'EENVELOPE', message: 'no recipients' }, PermanentDeliveryError, 'EENVELOPE'],
      [{ code: 'EMESSAGE', responseCode: 554, message: 'rejected' }, PermanentDeliveryError, '554'],
      [
        { code: 'EAUTH', responseCode: 535, message: 'bad creds' },
        NotifierConfigurationError,
        'EAUTH',
      ],
      [{ responseCode: 530, message: 'auth required' }, NotifierConfigurationError, '530'],
      [{ message: 'mystery' }, TransientDeliveryError, undefined],
    ];
    for (const [input, expectedClass, providerCode] of cases) {
      const mapped = mapSmtpError(Object.assign(new Error(String(input.message)), input));
      expect(mapped, JSON.stringify(input)).toBeInstanceOf(expectedClass);
      expect(mapped.providerCode).toBe(providerCode);
      expect(mapped.adapter).toBe('smtp');
    }
    expect(mapSmtpError('a string')).toBeInstanceOf(TransientDeliveryError);
  });

  it('never leaks SMTP credentials from the connection URL into error messages', async () => {
    const transport = fakeTransport(() =>
      Promise.reject(
        Object.assign(new Error('connect ECONNREFUSED smtp://user:hunter2@host:25'), {
          code: 'ECONNECTION',
        }),
      ),
    );
    const notifier = createSmtpNotifier({ ...config, transport });
    const error = await notifier.send(baseMessage).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransientDeliveryError);
    expect((error as Error).message).not.toContain('hunter2');
  });

  it('throws a typed error, never success, when the SMTP host is unreachable (AC-ERROR-6)', async () => {
    // Nothing listens on port 1 of loopback: the same observable outcome as a dead SMTP relay.
    const notifier = createNotifier({
      notifierAdapter: 'smtp',
      smtpUrl: 'smtp://127.0.0.1:1',
      emailFrom: config.emailFrom,
    });
    const error = await notifier.send(baseMessage).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransientDeliveryError);
    expect(error).toMatchObject({ retryable: true, adapter: 'smtp' });
  });
});

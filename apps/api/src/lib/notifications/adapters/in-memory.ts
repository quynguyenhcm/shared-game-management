import { randomUUID } from 'node:crypto';
import {
  NotifierConfigurationError,
  PermanentDeliveryError,
  TransientDeliveryError,
} from '../errors.ts';
import type { EmailMessage, Notifier, SendResult } from '../notifier.ts';
import { validateEmailMessage } from '../validation.ts';

const ADAPTER = 'memory';
const DEFAULT_FROM = 'Shared Game Management <no-reply@localhost>';

export type FailureKind = 'transient' | 'permanent' | 'configuration';

export interface SentEmail extends EmailMessage {
  readonly from: string;
  readonly providerMessageId: string;
  readonly acceptedAt: Date;
}

export interface InMemoryNotifier extends Notifier {
  /** Every message accepted so far, in order (deduplicated sends are not repeated). */
  readonly sent: readonly SentEmail[];
  /** Makes every following send throw the given error class; `undefined` restores success. */
  failWith(kind: FailureKind | undefined): void;
  /** Forgets captured messages, idempotency keys and any configured failure. */
  reset(): void;
}

function failure(kind: FailureKind): Error {
  const init = { adapter: ADAPTER, providerCode: `simulated-${kind}` };
  switch (kind) {
    case 'transient':
      return new TransientDeliveryError('memory adapter simulated a transient failure', init);
    case 'permanent':
      return new PermanentDeliveryError('memory adapter simulated a permanent failure', init);
    case 'configuration':
      return new NotifierConfigurationError(
        'memory adapter simulated a configuration failure',
        init,
      );
  }
}

/** Test adapter: captures messages, dedupes by idempotencyKey and can be told to fail. */
export function createInMemoryNotifier(options: { defaultFrom?: string } = {}): InMemoryNotifier {
  const defaultFrom = options.defaultFrom ?? DEFAULT_FROM;
  const sent: SentEmail[] = [];
  const byKey = new Map<string, SentEmail>();
  let failing: FailureKind | undefined;

  function accept(message: EmailMessage): SendResult {
    validateEmailMessage(message, ADAPTER);
    if (failing !== undefined) throw failure(failing);
    const existing = byKey.get(message.idempotencyKey);
    if (existing) {
      return {
        providerMessageId: existing.providerMessageId,
        acceptedAt: existing.acceptedAt,
        deduplicated: true,
      };
    }
    const record: SentEmail = {
      ...message,
      from: message.from ?? defaultFrom,
      providerMessageId: `<${randomUUID()}@memory.test>`,
      acceptedAt: new Date(),
    };
    sent.push(record);
    byKey.set(message.idempotencyKey, record);
    return {
      providerMessageId: record.providerMessageId,
      acceptedAt: record.acceptedAt,
      deduplicated: false,
    };
  }

  return {
    sent,
    failWith(kind) {
      failing = kind;
    },
    reset() {
      sent.length = 0;
      byKey.clear();
      failing = undefined;
    },
    send(message: EmailMessage): Promise<SendResult> {
      try {
        return Promise.resolve(accept(message));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}

/**
 * Provider-neutral notification contract (architecture Q8, AC-VERIFY-16).
 *
 * Callers depend only on `Notifier`; the adapter (`smtp` or `memory`) is chosen by
 * `NOTIFIER_ADAPTER`. `send` resolves only once the provider has accepted the message and rejects
 * with a typed `NotificationError` otherwise, never with a fake success.
 */
import type { Config } from '../config/config.ts';
import { createInMemoryNotifier } from './adapters/in-memory.ts';
import { createSmtpNotifier, type SmtpTransport } from './adapters/smtp.ts';
import { NotifierConfigurationError } from './errors.ts';

/** A single mailbox: `a@b.c` or `Display Name <a@b.c>`. */
export type EmailAddress = string;

export interface EmailMessage {
  /** Exactly one recipient per send (per-recipient idempotency, suppression and retries). */
  readonly to: EmailAddress;
  /** At most 998 characters, no CR/LF (header-injection guard). */
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  /** Defaults to `EMAIL_FROM`. */
  readonly from?: EmailAddress;
  readonly replyTo?: EmailAddress;
  /** Required, at most 255 characters, e.g. `overdue-reminder:<payment_id>:<yyyy-mm-dd>`. */
  readonly idempotencyKey: string;
  /** Low-cardinality provider metadata, e.g. `{ template: 'low-credit' }`. */
  readonly tags?: Readonly<Record<string, string>>;
}

export interface SendResult {
  readonly providerMessageId: string;
  readonly acceptedAt: Date;
  /** True when this idempotencyKey was already accepted and nothing new was sent. */
  readonly deduplicated: boolean;
}

export interface Notifier {
  send(message: EmailMessage): Promise<SendResult>;
}

export {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_SUBJECT_LENGTH,
  validateEmailMessage,
} from './validation.ts';

export interface NotifierDependencies {
  /** Test seam: replaces the nodemailer transport of the smtp adapter. */
  readonly smtpTransport?: SmtpTransport;
}

/** Builds the adapter selected by `NOTIFIER_ADAPTER`. The only place that knows the adapter names. */
export function createNotifier(
  config: Pick<Config, 'notifierAdapter' | 'smtpUrl' | 'emailFrom'>,
  dependencies: NotifierDependencies = {},
): Notifier {
  switch (config.notifierAdapter) {
    case 'memory':
      return createInMemoryNotifier({ defaultFrom: config.emailFrom });
    case 'smtp':
      return createSmtpNotifier({
        smtpUrl: config.smtpUrl,
        emailFrom: config.emailFrom,
        ...(dependencies.smtpTransport === undefined
          ? {}
          : { transport: dependencies.smtpTransport }),
      });
    default:
      throw new NotifierConfigurationError('unknown NOTIFIER_ADAPTER (expected smtp or memory)', {
        adapter: String(config.notifierAdapter),
      });
  }
}

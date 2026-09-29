import { createTransport } from 'nodemailer';
import type { NotificationError } from '../errors.ts';
import {
  NotifierConfigurationError,
  PermanentDeliveryError,
  TransientDeliveryError,
} from '../errors.ts';
import type { EmailMessage, Notifier, SendResult } from '../notifier.ts';
import { validateEmailMessage } from '../validation.ts';

const ADAPTER = 'smtp';
const CONNECT_TIMEOUT_MS = 5_000;
const IO_TIMEOUT_MS = 15_000;

/** The slice of a nodemailer transporter this adapter needs (also the test seam). */
export interface SmtpTransport {
  sendMail(mail: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html?: string;
    replyTo?: string;
    headers: Record<string, string>;
  }): Promise<{ messageId: string }>;
}

const NETWORK_CODES = new Set([
  'ECONNECTION',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ESOCKET',
  'ESOCKETTIMEDOUT',
  'EDNS',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);
const AUTH_RESPONSE_CODES = new Set([530, 534, 535, 538]);
const USERINFO = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/)[^/\s@]{0,512}@/gi;

interface SmtpErrorShape {
  code?: unknown;
  responseCode?: unknown;
  message?: unknown;
}

/** Error text without connection-string credentials, which nodemailer can echo. */
function safeMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(USERINFO, '$1[REDACTED]@');
}

/**
 * Maps a nodemailer failure onto the typed classes: network/timeout and 4xx replies are transient,
 * authentication failures are configuration, other 5xx replies and envelope errors are permanent.
 * Unknown failures are treated as transient (retrying is safe because sends are idempotent-keyed).
 */
export function mapSmtpError(error: unknown): NotificationError {
  const shape: SmtpErrorShape = typeof error === 'object' && error !== null ? error : {};
  const code = typeof shape.code === 'string' ? shape.code : undefined;
  const responseCode = typeof shape.responseCode === 'number' ? shape.responseCode : undefined;
  const message = safeMessage(error);
  const init = (providerCode: string | undefined) => ({
    adapter: ADAPTER,
    ...(providerCode === undefined ? {} : { providerCode }),
    cause: error,
  });

  if (code === 'EAUTH' || (responseCode !== undefined && AUTH_RESPONSE_CODES.has(responseCode))) {
    return new NotifierConfigurationError(
      `smtp authentication failed: ${message}`,
      init(code ?? String(responseCode)),
    );
  }
  if (responseCode !== undefined) {
    const providerCode = String(responseCode);
    if (responseCode >= 400 && responseCode < 500) {
      return new TransientDeliveryError(`smtp temporary failure: ${message}`, init(providerCode));
    }
    if (responseCode >= 500) {
      return new PermanentDeliveryError(
        `smtp rejected the message: ${message}`,
        init(providerCode),
      );
    }
  }
  if (code === 'EENVELOPE' || code === 'EMESSAGE') {
    return new PermanentDeliveryError(`smtp rejected the message: ${message}`, init(code));
  }
  if (code !== undefined && NETWORK_CODES.has(code)) {
    return new TransientDeliveryError(`smtp connection failed: ${message}`, init(code));
  }
  return new TransientDeliveryError(`smtp delivery failed: ${message}`, init(code));
}

/** Tag metadata travels as `X-Tag-<key>` headers (SMTP has no native metadata). */
function tagHeaders(tags: EmailMessage['tags']): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tags ?? {}).map(([key, value]) => [`X-Tag-${key}`, value]),
  );
}

export interface SmtpNotifierOptions {
  readonly smtpUrl: string;
  readonly emailFrom: string;
  /** Test seam; defaults to a nodemailer transport on `smtpUrl`. */
  readonly transport?: SmtpTransport;
}

/**
 * nodemailer transport options. File and URL access are disabled so a message field can never make
 * the transport read a local file or fetch a remote URL (e.g. `html: { path: '/etc/passwd' }`).
 */
export function smtpTransportOptions(smtpUrl: string) {
  return {
    url: smtpUrl,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: IO_TIMEOUT_MS,
    disableFileAccess: true,
    disableUrlAccess: true,
  } as const;
}

/** SMTP adapter (Mailpit in dev and CI; also works against a provider's SMTP relay). */
export function createSmtpNotifier(options: SmtpNotifierOptions): Notifier {
  const transport: SmtpTransport =
    options.transport ?? createTransport(smtpTransportOptions(options.smtpUrl));

  return {
    async send(message: EmailMessage): Promise<SendResult> {
      validateEmailMessage(message, ADAPTER);
      try {
        const info = await transport.sendMail({
          from: message.from ?? options.emailFrom,
          to: message.to,
          subject: message.subject,
          text: message.text,
          ...(message.html === undefined ? {} : { html: message.html }),
          ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
          headers: {
            'X-Idempotency-Key': message.idempotencyKey,
            ...tagHeaders(message.tags),
          },
        });
        return { providerMessageId: info.messageId, acceptedAt: new Date(), deduplicated: false };
      } catch (error) {
        throw mapSmtpError(error);
      }
    },
  };
}

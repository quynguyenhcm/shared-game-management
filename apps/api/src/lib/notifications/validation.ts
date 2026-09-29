import { PermanentDeliveryError } from './errors.ts';
import type { EmailMessage } from './notifier.ts';

export const MAX_SUBJECT_LENGTH = 998;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
const MAX_TAG_VALUE_LENGTH = 256;
const TAG_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const CONTROL = /[\r\n]/;
// One mailbox only: no list separators, no angle brackets except a single trailing <addr>.
const MAILBOX = /^(?:[^<>\r\n,;]*<[^\s<>,;@]+@[^\s<>,;@]+>|[^\s<>,;@]+@[^\s<>,;@]+)$/;

function invalid(adapter: string, reason: string): PermanentDeliveryError {
  return new PermanentDeliveryError(`invalid email message: ${reason}`, {
    adapter,
    providerCode: 'invalid_message',
  });
}

function checkAddress(adapter: string, field: string, value: unknown): void {
  if (typeof value !== 'string' || !MAILBOX.test(value.trim())) {
    throw invalid(adapter, `${field} must be exactly one valid email address`);
  }
}

/**
 * Validates a message before any adapter touches it, so every adapter rejects the same inputs
 * the same way (header injection, multiple recipients, missing idempotency key).
 * @throws PermanentDeliveryError with providerCode `invalid_message`
 */
export function validateEmailMessage(message: EmailMessage, adapter: string): void {
  checkAddress(adapter, 'to', message.to);
  if (message.from !== undefined) checkAddress(adapter, 'from', message.from);
  if (message.replyTo !== undefined) checkAddress(adapter, 'replyTo', message.replyTo);
  if (typeof message.subject !== 'string' || message.subject.length === 0) {
    throw invalid(adapter, 'subject is required');
  }
  if (message.subject.length > MAX_SUBJECT_LENGTH) {
    throw invalid(adapter, `subject exceeds ${MAX_SUBJECT_LENGTH} characters`);
  }
  if (CONTROL.test(message.subject)) throw invalid(adapter, 'subject must not contain CR or LF');
  if (typeof message.text !== 'string') throw invalid(adapter, 'text body is required');
  const key = message.idempotencyKey;
  if (typeof key !== 'string' || key.length === 0)
    throw invalid(adapter, 'idempotencyKey is required');
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH || CONTROL.test(key)) {
    throw invalid(
      adapter,
      `idempotencyKey must be a single line of at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
    );
  }
  for (const [tagKey, tagValue] of Object.entries(message.tags ?? {})) {
    if (!TAG_KEY.test(tagKey)) throw invalid(adapter, 'tag keys must match [A-Za-z0-9_-]{1,64}');
    if (
      typeof tagValue !== 'string' ||
      tagValue.length > MAX_TAG_VALUE_LENGTH ||
      CONTROL.test(tagValue)
    ) {
      throw invalid(adapter, 'tag values must be single-line strings');
    }
  }
}

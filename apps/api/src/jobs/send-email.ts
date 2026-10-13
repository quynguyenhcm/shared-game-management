import { z } from 'zod';
import type { FieldCrypto } from '../lib/crypto/crypto.ts';
import {
  NonRetryableJobError,
  type JobHandler,
  type JobRunner,
  type TransactionLike,
} from '../lib/jobs/jobs.ts';
import { NotificationError, TransientDeliveryError } from '../lib/notifications/errors.ts';
import type { EmailMessage, Notifier } from '../lib/notifications/notifier.ts';
import { QUEUE_NAMES } from './registry.ts';

/**
 * `send-email` job: delivers one message through the configured Notifier.
 * Transient failures are rethrown so pg-boss retries with backoff. Permanent and configuration
 * failures are logged at error and fail the job at once (no retries can fix them).
 */
/**
 * Runtime shape of a `send-email` payload (the job row is untyped JSON). Strict: an unknown field
 * such as `attachments` fails the job instead of reaching the transport. Content rules (single
 * recipient, header injection, lengths) stay in `validateEmailMessage`.
 */
export const SendEmailPayload = z.strictObject({
  to: z.string(),
  subject: z.string(),
  text: z.string(),
  html: z.string().optional(),
  from: z.string().optional(),
  replyTo: z.string().optional(),
  idempotencyKey: z.string(),
  tags: z.record(z.string(), z.string()).optional(),
});

/**
 * A message sealed for the queue: `pgboss.job.data` is retained for days, so a message that carries a secret
 * (the reset link) is stored as one `FieldCrypto` envelope. The idempotency key stays readable (it names the
 * job, never a secret) and is bound into the envelope as its row id, so a payload moved to another job fails.
 */
const SealedEmailPayload = z.strictObject({ idempotencyKey: z.string(), sealed: z.string() });

const sealContext = (idempotencyKey: string) => ({
  table: 'pgboss.job',
  column: 'data.send-email',
  rowId: idempotencyKey,
});

/** The plain message from a sealed payload, or the payload itself when it was never sealed. */
function openPayload(payload: unknown, crypto: FieldCrypto): unknown {
  const sealed = SealedEmailPayload.safeParse(payload);
  if (!sealed.success) return payload;
  try {
    const message: unknown = JSON.parse(
      crypto.decrypt(sealed.data.sealed, sealContext(sealed.data.idempotencyKey)),
    );
    return message;
  } catch {
    // Never echo the cause: a decryption error must not become a place the ciphertext or key id leaks to.
    return { unreadable: true };
  }
}

export function createSendEmailHandler(
  notifier: Notifier,
  crypto: FieldCrypto,
): JobHandler<EmailMessage> {
  return async (rawPayload, context) => {
    const payload = openPayload(rawPayload, crypto);
    const parsed = SendEmailPayload.safeParse(payload);
    if (!parsed.success) {
      // Field paths only: the payload itself may contain personal data.
      const fields = [
        ...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)')),
      ];
      context.logger.error(
        { event: 'notification.invalid_payload', fields },
        'send-email payload is malformed',
      );
      throw new NonRetryableJobError(`malformed send-email payload: ${fields.join(', ')}`);
    }
    const message: EmailMessage = parsed.data;
    try {
      const result = await notifier.send(message);
      context.logger.info(
        {
          event: 'notification.sent',
          providerMessageId: result.providerMessageId,
          deduplicated: result.deduplicated,
          idempotencyKey: message.idempotencyKey,
        },
        'notification sent',
      );
    } catch (error) {
      if (error instanceof TransientDeliveryError || !(error instanceof NotificationError)) {
        throw error;
      }
      context.logger.error(
        {
          event: 'notification.failed',
          adapter: error.adapter,
          providerCode: error.providerCode,
          retryable: error.retryable,
          idempotencyKey: message.idempotencyKey,
          err: error,
        },
        'notification failed permanently',
      );
      throw new NonRetryableJobError(error.message, { cause: error });
    }
  };
}

/** Enqueues an email job; a queued or active job with the same idempotencyKey suppresses the duplicate. */
export function enqueueEmail(
  runner: Pick<JobRunner, 'enqueue'>,
  message: EmailMessage,
  options: { trx?: TransactionLike; crypto?: FieldCrypto } = {},
): Promise<string | null> {
  // Pass `crypto` for a message that carries a secret: only its envelope reaches the job table.
  const data =
    options.crypto === undefined
      ? message
      : {
          idempotencyKey: message.idempotencyKey,
          sealed: options.crypto.encrypt(
            JSON.stringify(message),
            sealContext(message.idempotencyKey),
          ),
        };
  return runner.enqueue(QUEUE_NAMES.sendEmail, data, {
    singletonKey: `notify:${message.idempotencyKey}`,
    ...(options.trx === undefined ? {} : { trx: options.trx }),
  });
}

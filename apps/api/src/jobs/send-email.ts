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
export function createSendEmailHandler(notifier: Notifier): JobHandler<EmailMessage> {
  return async (message, context) => {
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
  options: { trx?: TransactionLike } = {},
): Promise<string | null> {
  return runner.enqueue(QUEUE_NAMES.sendEmail, message, {
    singletonKey: `notify:${message.idempotencyKey}`,
    ...(options.trx === undefined ? {} : { trx: options.trx }),
  });
}
